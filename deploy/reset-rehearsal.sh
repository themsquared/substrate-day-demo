#!/usr/bin/env bash
# Reset the rig between rehearsals: delete the demo Sessions (and with them
# their Substrate actors), put every WorkerPool back to 1 worker pod, and
# restart the Telegram doorbell so it forgets the deleted Session.
#
#   deploy/reset-rehearsal.sh                 # dry run (the default): print what it would delete
#   deploy/reset-rehearsal.sh --yes           # do it
#   KUBE_CONTEXT=kind-substrate-day deploy/reset-rehearsal.sh --yes
#
# Options:
#   --yes                    act (without it nothing is changed)
#   --dry-run                print only (the default)
#   --no-doorbell-restart    leave deploy/telegram-doorbell alone
#   --keep-pools             do not scale the WorkerPools
#   --concurrency N          parallel DeleteSession calls (default 4)
#
# How, on kagent 1.0.0-rc2 + Substrate 1.0.0-rc.2:
#   * Sessions: kagent.api.v1.SessionService/DeleteSession over gRPC-Web on the
#     controller (the RPC `kagent agent session delete ID` calls). It deletes
#     the Session's actor too: the controller suspends it if needed, then calls
#     ateapi DeleteActor (verified 11-04: actor count drops 1:1). The Session
#     row stays in the database as RUNTIME_STATE_DELETED; ListSessions hides it.
#     It is sent as each Session's creator (X-User-Id), so all creators go.
#   * Skipped, never touched: a Session with lifecycle work pending, and any
#     Session whose actor is on a worker (Resuming/Running/Suspending/
#     Reverting, or has a worker_pod). A ghost actor that is stuck Resuming is
#     one of those: RESET POOL is its fix, not this script.
#   * Orphan actors (session-<uuid> in the namespace's atespace, Suspended or
#     Crashed, off every worker, and no live Session) are deleted with the
#     rc2 kubectl-ate plugin, if one is installed (KUBECTL_ATE=path to pick
#     one). The old plugin speaks ateapi.Control and cannot. Normally there
#     are none, because DeleteSession already removes the actor.
#   * Never touched: ActorTemplates, golden snapshots, tags, Agents, Harnesses,
#     ModelConfigs, other namespaces, other kube contexts.
#
# Idempotent: a second run finds nothing to delete. Never prints secrets.
# Exit code: 0 ok, 1 something failed (see FAIL lines).
set -uo pipefail

CTX="${KUBE_CONTEXT:-kind-substrate-day}"
NS="${KAGENT_NAMESPACE:-kagent}"
SCOPE="${SCOPE_URL:-http://127.0.0.1:${PORT:-8123}}"
LIB="$(cd "$(dirname "$0")/../scope/lib" && pwd)/grpcweb.mjs"
YES=0; RESTART_DOORBELL=1; KEEP_POOLS=0; CONC=4
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1;;
    --dry-run) YES=0;;
    --no-doorbell-restart) RESTART_DOORBELL=0;;
    --keep-pools) KEEP_POOLS=1;;
    --concurrency) CONC="${2:?--concurrency needs a number}"; shift;;
    -h|--help) sed -n '2,37p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2;;
  esac
  shift
done

K=(kubectl --context "$CTX")
FAILS=0
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAILS=$((FAILS + 1)); }
step() { printf '\n%s\n' "$*"; }
act()  { [ "$YES" = 1 ]; }

[ -f "$LIB" ] || { echo "cannot find $LIB (run from the substrate-day-demo checkout)" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
"${K[@]}" get --raw /readyz >/dev/null 2>&1 || { echo "context $CTX: API server not reachable" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/reset-rehearsal.XXXXXX")"
PF_PID=""
cleanup() { [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

printf 'reset-rehearsal: context %s, namespace %s, %s\n' "$CTX" "$NS" "$(act && echo 'ACTING (--yes)' || echo 'DRY RUN (pass --yes to act)')"

# ── controller port-forward (its own, on a free port; Scope keeps its own) ────
"${K[@]}" port-forward -n "$NS" svc/kagent-controller :8083 >"$TMP/pf.log" 2>&1 &
PF_PID=$!
API=""
for _ in $(seq 1 40); do
  port=$(sed -n 's/^Forwarding from 127\.0\.0\.1:\([0-9]*\).*/\1/p' "$TMP/pf.log" | head -1)
  [ -n "$port" ] && { API="http://127.0.0.1:$port"; break; }
  sleep 0.25
done
[ -n "$API" ] || { echo "port-forward to svc/kagent-controller failed: $(tail -2 "$TMP/pf.log")" >&2; exit 1; }

# ── the node helper: inventory / delete, over gRPC-Web ───────────────────────
# argv: mode (count|plan|delete) api ns concurrency
read -r -d '' HELPER <<'JS'
const [lib, mode, api, ns, conc] = process.argv.slice(1);
const { client, GrpcError } = await import(lib);
const as = user => client(`${api}/api`, async () => ({ 'X-User-Id': user }));
const admin = as('admin@kagent.dev');
async function all(method, req, key) {
  const out = []; let token = '';
  for (let i = 0; i < 1000; i++) {
    const r = await admin.unary(method, { ...req, page: { limit: 100, page_token: token } }, { timeout: 10000 });
    out.push(...(r[key] ?? [])); token = r.page?.next_page_token;
    if (!token) return out;
  }
  throw new Error(`${method}: more than 1000 pages`);
}
const ON_WORKER = new Set(['ACTOR_STATE_RESUMING', 'ACTOR_STATE_RUNNING', 'ACTOR_STATE_SUSPENDING', 'ACTOR_STATE_REVERTING']);
const OFF_WORKER = new Set(['ACTOR_STATE_SUSPENDED', 'ACTOR_STATE_CRASHED']);
const SESSION_ACTOR = /^session-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const short = s => s.replace(/^ACTOR_STATE_|^RUNTIME_STATE_/, '').toLowerCase();
const tally = (xs, f) => Object.entries(xs.reduce((m, x) => (m[f(x)] = (m[f(x)] ?? 0) + 1, m), {}))
  .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(', ') || 'none';

async function inventory() {
  const [sessions, actors] = await Promise.all([
    all('kagent.api.v1.SessionService/ListSessions', { all_creators: true }, 'sessions'),
    all('kagent.api.v1.SystemService/ListSubstrateActors', { atespace: ns }, 'actors'),
  ]);
  const mine = sessions.filter(s => (s.agent?.ref?.namespace ?? '') === ns);
  const nsActors = actors.filter(a => a.metadata?.atespace === ns);
  const byName = new Map(nsActors.map(a => [a.metadata.name, a]));
  const onWorker = a => a && (ON_WORKER.has(a.status?.state) || !!a.status?.worker_assignment?.worker_pod);
  const del = [], skip = [];
  for (const s of mine) {
    const a = byName.get(`session-${s.id}`);
    const why = (s.operation && s.operation !== 'RUNTIME_OPERATION_NONE') ? `lifecycle work pending (${s.operation})`
              : onWorker(a) ? `actor on a worker (${short(a.status?.state ?? '?')} ${a.status?.worker_assignment?.worker_pod ?? ''})`.trim()
              : a && !OFF_WORKER.has(a.status?.state) ? `actor state ${a.status?.state ?? 'unset'}` : '';
    (why ? skip : del).push({ s, a, why });
  }
  const live = new Set(mine.map(s => s.id));
  const orphans = nsActors.filter(a => {
    const m = SESSION_ACTOR.exec(a.metadata.name);
    return m && !live.has(m[1]) && OFF_WORKER.has(a.status?.state) && !onWorker(a);
  });
  return { mine, nsActors, del, skip, orphans,
           other: sessions.length - mine.length };
}
function summary(inv, label) {
  console.log(`  ${label}: sessions ${inv.mine.length} (${tally(inv.mine, s => short(s.state))})` +
              ` · actors ${inv.nsActors.length} (${tally(inv.nsActors, a => short(a.status?.state ?? 'unset'))})` +
              (inv.other ? ` · ${inv.other} session(s) in other namespaces left alone` : ''));
}

const inv = await inventory();
if (mode === 'count') { summary(inv, process.env.LABEL || 'now'); process.exit(0); }

console.log(`  to delete: ${inv.del.length} session(s) (+ their actors), by agent: ${tally(inv.del, d => d.s.agent?.ref?.name ?? '?')}`);
for (const d of inv.skip) console.log(`  skip  session ${d.s.id} (${d.s.agent?.ref?.name}): ${d.why}`);
for (const a of inv.orphans) console.log(`  orphan actor ${a.metadata.name} (${short(a.status.state)}) has no live Session`);
const oncall = inv.del.filter(d => d.s.agent?.ref?.name === (process.env.TELEGRAM_AGENT || 'sre-oncall')).length;
const meta = { del: inv.del.length, skip: inv.skip.length, orphans: inv.orphans.map(a => a.metadata.name), oncall };

if (mode === 'plan') {
  for (const d of inv.del.slice(-5)) console.log(`  e.g.  ${d.s.id} ${d.s.agent?.ref?.name} actor ${short(d.a?.status?.state ?? 'none')}`);
  console.log('META ' + JSON.stringify(meta));
  process.exit(0);
}

// mode === 'delete': as each Session's creator, `conc` at a time
let done = 0, failed = 0, aborted = [];
const queue = [...inv.del];
const t0 = Date.now();
async function worker() {
  for (let d; (d = queue.shift()); ) {
    try {
      const r = await as(d.s.creator || 'admin@kagent.dev').unary('kagent.api.v1.SessionService/DeleteSession',
                                                                 { session_id: d.s.id }, { timeout: 60000 });
      if (r.session?.state !== 'RUNTIME_STATE_DELETED') throw new Error(`state after delete: ${r.session?.state ?? '(none)'}`);
      if (++done % 100 === 0) console.log(`  … ${done}/${inv.del.length} deleted (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    } catch (e) {
      // ABORTED = lifecycle work became active: leave it for a rerun
      if (e instanceof GrpcError && Number(e.code) === 10) aborted.push(d.s.id);
      else { failed++; console.log(`  FAIL  delete ${d.s.id} (${d.s.agent?.ref?.name}): ${String(e.message ?? e).slice(0, 200)}`); }
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, Number(conc) || 4) }, worker));
console.log(`  deleted ${done} session(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
            (aborted.length ? `, ${aborted.length} busy (rerun the script)` : '') + (failed ? `, ${failed} FAILED` : ''));
console.log('META ' + JSON.stringify({ ...meta, done, failed, aborted: aborted.length }));
JS

helper() { node --input-type=module -e "$HELPER" "$LIB" "$@"; }

agents_ready() {
  "${K[@]}" get agents.api.kagent.dev -n "$NS" -o json 2>/dev/null | node -e '
    const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const r = j.items.filter(a => (a.status?.conditions ?? []).some(c => c.type === "Ready" && c.status === "True"));
    console.log(`${r.length}/${j.items.length}`);'
}
pools() {
  "${K[@]}" get workerpools.ate.dev -n "$NS" -o json 2>/dev/null | node -e '
    const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
    console.log(j.items.map(p => `${p.metadata.name} ${p.status?.readyReplicas ?? 0}/${p.spec.replicas}`).join(" · ") || "none");'
}

# ── before ───────────────────────────────────────────────────────────────────
step "before"
LABEL=before helper count "$API" "$NS" "$CONC" || { bad "inventory failed"; exit 1; }
echo "  agents Ready $(agents_ready) · pools $(pools)"
if scope=$(curl -s -m 3 "$SCOPE/status" 2>/dev/null) && [ -n "$scope" ]; then
  node -e '
    const j = JSON.parse(process.argv[1]);
    const busy = (j.router?.ownInflight ?? 0) + (j.router?.parked ?? 0);
    console.log(`  Scope ${process.argv[2]}: demo ${j.demoRun ? "RUNNING" : "STOPPED"} · autoscale ${j.autoscale ? "ON" : "OFF"} · in flight ${j.router?.ownInflight ?? 0} · parked ${j.router?.parked ?? 0}`);
    if (busy) console.log("  warn  Scope has chats in flight: press STOP DEMO first, or their Sessions are skipped");
    if (j.autoscale) console.log("  note  AUTOSCALE is ON: Scope owns the pool size and may scale it again after this script");' "$scope" "$SCOPE" 2>/dev/null || true
fi

# ── plan ─────────────────────────────────────────────────────────────────────
step "plan"
plan=$(helper plan "$API" "$NS" "$CONC") || { bad "plan failed"; exit 1; }
grep -v '^META ' <<<"$plan"
meta=$(sed -n 's/^META //p' <<<"$plan")
n_del=$(node -e 'console.log(JSON.parse(process.argv[1]).del)' "$meta")
orphans=$(node -e 'console.log(JSON.parse(process.argv[1]).orphans.join("\n"))' "$meta")

if ! act; then
  step "dry run: nothing changed"
  echo "  would delete $n_del session(s) and their actors, $(grep -c . <<<"$orphans") orphan actor(s)"
  [ "$KEEP_POOLS" = 0 ] && echo "  would scale every WorkerPool in $NS to 1 (now: $(pools))"
  [ "$RESTART_DOORBELL" = 1 ] && "${K[@]}" get deploy/telegram-doorbell -n "$NS" >/dev/null 2>&1 && [ "$n_del" -gt 0 ] &&
    echo "  would restart deploy/telegram-doorbell (its chat -> Session map points at a deleted Session)"
  echo "  rerun with --yes to act"
  exit 0
fi

# ── delete sessions (and their actors) ───────────────────────────────────────
step "delete sessions"
if [ "$n_del" -gt 0 ]; then
  out=$(helper delete "$API" "$NS" "$CONC"); rc=$?
  grep -v '^META ' <<<"$out" | grep -v '^  orphan actor\|^  skip  \|^  to delete'
  dmeta=$(sed -n 's/^META //p' <<<"$out")
  failed=$(node -e 'console.log(JSON.parse(process.argv[1] || "{\"failed\":1}").failed)' "$dmeta")
  [ "$rc" = 0 ] && [ "$failed" = 0 ] && ok "sessions deleted" || bad "$failed session delete(s) failed (rc $rc)"
else
  ok "no sessions to delete"
fi

# ── orphan actors (normally none: DeleteSession removes the actor) ───────────
step "orphan actors"
# DeleteSession is synchronous, but take the list again after it.
orphans=$(helper plan "$API" "$NS" "$CONC" | sed -n 's/^META //p' | node -e '
  const m = JSON.parse(require("fs").readFileSync(0, "utf8") || "{\"orphans\":[]}"); console.log(m.orphans.join("\n"));')
if [ -z "$orphans" ]; then
  ok "none"
else
  ATE="${KUBECTL_ATE:-$(command -v kubectl-ate || true)}"
  if [ -n "$ATE" ] && "$ATE" --version 2>/dev/null | grep -q 'v1\.0\.0'; then
    for a in $orphans; do
      if "$ATE" --context "$CTX" delete actor "$a" -a "$NS" >/dev/null 2>"$TMP/ate.err"; then ok "deleted orphan actor $a"
      else bad "delete orphan actor $a: $(head -c 200 "$TMP/ate.err")"; fi
    done
  else
    bad "$(grep -c . <<<"$orphans") orphan actor(s) left: no rc2 kubectl-ate (the installed one, if any, speaks the old ateapi.Control)."
    echo "        build one: cd <agent-substrate v1.0.0-rc.2 checkout> && go build -o \"\$HOME/bin/kubectl-ate\" ./cmd/kubectl-ate"
    echo "        then: KUBECTL_ATE=\$HOME/bin/kubectl-ate $0 --yes"
  fi
fi

# ── pools back to rest ───────────────────────────────────────────────────────
if [ "$KEEP_POOLS" = 0 ]; then
  step "worker pools → 1"
  for p in $("${K[@]}" get workerpools.ate.dev -n "$NS" -o jsonpath='{.items[*].metadata.name}'); do
    want=$("${K[@]}" get workerpools.ate.dev "$p" -n "$NS" -o jsonpath='{.spec.replicas}')
    [ "$want" = 1 ] || "${K[@]}" scale workerpools.ate.dev "$p" -n "$NS" --replicas=1 >/dev/null || bad "scale $p"
  done
  rest=1
  for _ in $(seq 1 60); do
    "${K[@]}" get workerpools.ate.dev -n "$NS" -o json | node -e '
      const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
      process.exit(j.items.every(p => p.spec.replicas === 1 && (p.status?.readyReplicas ?? 0) === 1) ? 0 : 1);' && { rest=0; break; }
    sleep 2
  done
  echo "  $(pools)"
  [ "$rest" = 0 ] && ok "every pool at 1/1" || bad "pools not at 1/1 after 120s"
fi

# ── doorbell: its chat -> Session map is in memory ───────────────────────────
# A deleted contextId gets "task not found", which the doorbell treats as a
# gone Session and retries once on a new one. The restart makes it clean.
if [ "$RESTART_DOORBELL" = 1 ] && [ "$n_del" -gt 0 ] && "${K[@]}" get deploy/telegram-doorbell -n "$NS" >/dev/null 2>&1; then
  step "telegram doorbell"
  "${K[@]}" rollout restart deploy/telegram-doorbell -n "$NS" >/dev/null &&
  "${K[@]}" rollout status deploy/telegram-doorbell -n "$NS" --timeout=120s >/dev/null &&
    ok "restarted: the next Telegram message starts a new Session" || bad "doorbell restart"
fi

# ── after ────────────────────────────────────────────────────────────────────
step "after"
LABEL=after helper count "$API" "$NS" "$CONC" || bad "inventory failed"
ready=$(agents_ready)
echo "  agents Ready $ready · pools $(pools)"
[ "${ready%/*}" = "${ready#*/}" ] && ok "all Agents Ready" || bad "Agents not all Ready ($ready)"
echo "  next: reload the Scope tab (an open page logs false 'between samples' lines for the deleted sessions)"
exit $((FAILS > 0))
