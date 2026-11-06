#!/usr/bin/env bash
# Preflight for a live Substrate Scope demo on kagent 1.0.0-rc2/rc3 + Substrate 1.0.0-rc2/1.0.0.
#
#   KUBE_CONTEXT=kind-substrate-day deploy/preflight.sh
#   SKIP_TURN=1 deploy/preflight.sh          # skip the one billable LLM turn
#   AGENT=sre-oncall deploy/preflight.sh
#
# Checks, in order: cluster reachable, control-plane pods healthy, every Agent
# Ready, WorkerPools at their replica count, the router's parking budget,
# controller reachable over gRPC-Web (SystemService) with a non-empty
# inventory, atenet-router and ate-api-server metrics reachable, one real A2A
# turn, and (if running) Scope.
# Exit code = number of failed checks. Never prints secrets.
set -uo pipefail

CTX="${KUBE_CONTEXT:-$(kubectl config current-context)}"
NS="${KAGENT_NAMESPACE:-kagent}"
AGENT="${AGENT:-k8s-tutor}"
SCOPE="${SCOPE_URL:-http://127.0.0.1:${PORT:-8123}}"
HERE="$(cd "$(dirname "$0")/../scope" && pwd)"   # Scope lives in scope/ in this repo
K=(kubectl --context "$CTX")
FAILS=0
report() { # lines of LEVEL|message -> ok/warn/bad (in this shell, so FAILS counts)
  while IFS='|' read -r lvl msg; do
    [ -z "$lvl" ] && continue
    case "$lvl" in OK) ok "$msg";; WARN) warn "$msg";; *) bad "$msg";; esac
  done <<<"$1"
}
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAILS=$((FAILS + 1)); }
step() { printf '\n%s\n' "$*"; }

PF_PID=""
cleanup() { [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null; }
trap cleanup EXIT

step "cluster ($CTX)"
if ! "${K[@]}" get --raw /readyz >/dev/null 2>&1; then
  bad "API server not reachable in context $CTX"; exit 1
fi
ok "API server ready"
notready=$("${K[@]}" get nodes --no-headers 2>/dev/null | awk '$2!="Ready"{print $1}')
[ -z "$notready" ] && ok "nodes Ready ($("${K[@]}" get nodes --no-headers | wc -l | tr -d ' '))" || bad "nodes not Ready: $notready"

step "control plane pods"
for ns in ate-system "$NS"; do
  # Running pods must be fully ready; Completed jobs are fine
  badpods=$("${K[@]}" get pods -n "$ns" --no-headers 2>/dev/null | awk '{split($2,r,"/"); if (!($3=="Completed" || ($3=="Running" && r[1]==r[2]))) print $1" "$2" "$3}')
  n=$("${K[@]}" get pods -n "$ns" --no-headers 2>/dev/null | wc -l | tr -d ' ')
  [ -z "$badpods" ] && ok "$ns: $n pods healthy" || bad "$ns: unhealthy pods: $(echo $badpods)"
done

step "agents"
agents_json=$("${K[@]}" get agents.api.kagent.dev -n "$NS" -o json 2>/dev/null)
if [ -z "$agents_json" ]; then bad "cannot list agents.api.kagent.dev (kagent 1.0 CRDs missing?)"; else
  read -r total notready <<<"$(node -e '
    const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const nr = j.items.filter(a => !(a.status?.conditions ?? []).some(c => c.type === "Ready" && c.status === "True"));
    console.log(j.items.length, nr.map(a => a.metadata.name).join(",") || "-");' <<<"$agents_json")"
  [ "$notready" = "-" ] && ok "$total Agents, all Ready" || bad "Agents not Ready: $notready (of $total)"
fi

step "worker pools"
out=$("${K[@]}" get workerpools.ate.dev -A -o json | node -e '
  const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
  for (const p of j.items) {
    const want = p.spec.replicas, ready = p.status?.readyReplicas ?? 0;
    const lim = p.spec.template?.resources?.limits;
    const tag = `${p.metadata.namespace}/${p.metadata.name}`;
    console.log(`${ready === want ? "OK" : "BAD"}|${tag}: ${ready}/${want} ready, image ${p.spec.workerImage}`);
    if (!lim) console.log(`WARN|${tag}: no pod limits — each worker advertises the whole node, so the pool never looks full`);
  }')
report "$out"

step "atenet-router config"
out=$("${K[@]}" get configmaps -n ate-system -o json 2>/dev/null | node -e '
  const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const c = (j.items ?? []).find(c => /atenet-router-agentgateway-config$/.test(c.metadata?.name ?? ""))?.data?.["config.yaml"] ?? "";
  const b = c.match(/requestParking:\s*\n\s*budget:\s*"?([\w.]+)"?/)?.[1], t = c.match(/\n\s*requestTimeout:\s*"?([\w.]+)"?/)?.[1];
  // 5s on the rc2 chart, 60s on the 1.0.0 chart (kagent install sets neither):
  // a pool-full chat waits this long in the router before the gateway answers -32004
  console.log(b ? `OK|parking budget ${b}${t ? `, request timeout ${t}` : ""} — a pool-full chat waits that long before -32004 (rc2 chart default 5s, 1.0.0 chart 60s)`
                : "WARN|router ConfigMap not found or has no requestParking.budget (rc2 chart default is 5s)");')
report "$out"

step "controller (gRPC-Web SystemService)"
"${K[@]}" port-forward -n "$NS" svc/kagent-controller :8083 >"${TMPDIR:-/tmp}/scope-preflight-pf.$$" 2>&1 &
PF_PID=$!
API=""
for _ in $(seq 1 40); do
  port=$(sed -n 's/^Forwarding from 127\.0\.0\.1:\([0-9]*\).*/\1/p' "${TMPDIR:-/tmp}/scope-preflight-pf.$$" | head -1)
  [ -n "$port" ] && { API="http://127.0.0.1:$port"; break; }
  sleep 0.25
done
rm -f "${TMPDIR:-/tmp}/scope-preflight-pf.$$"
if [ -z "$API" ]; then bad "port-forward to svc/kagent-controller failed"; else
  out=$(cd "$HERE" && API="$API" node --input-type=module -e '
    import { kagent } from "./lib/kagent.mjs";
    const k = kagent({ apiBase: process.env.API });
    try {
      const v = await k.version();
      const inv = await k.inventory();
      const t = inv.summary?.actor_templates?.length ?? 0;
      console.log(`OK|kagent ${v.kagent_version} (${v.git_commit}); ${inv.workers.length} workers, ${inv.actors.length} actors, ${t} actor templates`);
      if (inv.ateApiError) console.log(`BAD|ate-api error reported by controller: ${inv.ateApiError}`);
      if (!inv.workers.length) console.log("BAD|SystemService lists 0 workers");
      if (!t) console.log("BAD|SystemService lists 0 actor templates");
      // every chat is a Session + actor (idle TTL 7 days): rehearsals pile up
      if (inv.actors.length > 800) console.log(`WARN|${inv.actors.length} actors (one per session): delete rehearsal sessions before the show — inventory polling and ListSessions grow with them`);
    } catch (e) {
      const r = await fetch(`${process.env.API}/api/substrate/status`).catch(() => null);
      const body = r ? await r.text() : "";
      console.log(`BAD|gRPC-Web SystemService failed: ${e.message}` + (r?.ok && !body ? " (REST /api/substrate/status is an EMPTY 200: kagent 1.0 has no REST API)" : ""));
    }' 2>&1)
  report "$out"
fi

step "Prometheus metrics (API server pod proxy)"
scrape() { # app metric
  local pod port
  pod=$("${K[@]}" get pods -n ate-system -l app="$1" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  port=$("${K[@]}" get pod -n ate-system "$pod" -o jsonpath='{.metadata.annotations.prometheus\.io/port}' 2>/dev/null)
  [ -z "$pod" ] || [ -z "$port" ] && { bad "$1: no pod / no prometheus.io/port annotation"; return; }
  # read the whole body first: grep -q on a pipe + pipefail = SIGPIPE false negative
  local body
  body=$("${K[@]}" get --raw "/api/v1/namespaces/ate-system/pods/$pod:$port/proxy/metrics" --request-timeout=6s 2>/dev/null)
  if grep -q "^$2" <<<"$body"; then
    ok "$1 $pod:$port exposes $2"
  else bad "$1 $pod:$port: $2 not found"; fi
}
scrape atenet-router agentgateway_substrate_request_parking_active
scrape ate-api-server ate_scheduler_assignment_duration_seconds_count

step "one real turn ($NS/$AGENT)"
if [ -n "${SKIP_TURN:-}" ]; then warn "skipped (SKIP_TURN set)"
elif [ -z "$API" ]; then bad "no controller address"
else
  out=$(API="$API" NS="$NS" AGENT="$AGENT" node -e '
    const id = `preflight-${Date.now().toString(36)}`, t0 = Date.now();
    fetch(`${process.env.API}/agents/${process.env.NS}/${process.env.AGENT}`, {
      method: "POST", headers: { "content-type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "SendMessage",
        params: { message: { messageId: id, role: "ROLE_USER", parts: [{ text: "Reply with the single word: ready" }] } } }),
      signal: AbortSignal.timeout(90000) })
    .then(r => r.json()).then(j => {
      const ms = Date.now() - t0;
      if (j.error) return console.log(`BAD|JSON-RPC ${j.error.code}: ${j.error.message}`);
      const t = j.result?.task ?? {};
      const text = [...(t.artifacts ?? []).flatMap(a => a.parts ?? []), ...(t.status?.message?.parts ?? [])].map(p => p.text ?? "").join("").slice(0, 120);
      if (t.status?.state === "TASK_STATE_COMPLETED") console.log(`OK|${ms} ms restore+turn+checkpoint: ${text.replace(/\n/g, " ")}`);
      else if (/x-api-key|authentication|401/i.test(text)) console.log(`BAD|${t.status?.state}: model provider rejected the API key (rotate Secret kagent-anthropic) — ${text}`);
      else console.log(`BAD|${t.status?.state}: ${text}`);
    }).catch(e => console.log(`BAD|${e.message}`));' 2>&1)
  report "$out"
fi

step "Scope ($SCOPE)"
if s=$(curl -s --max-time 3 "$SCOPE/status"); then
  out=$(echo "$s" | node -e '
    const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
    console.log(`${j.health?.level === "ok" ? "OK" : "BAD"}|mode ${j.mode}, health ${j.health?.level}: ${j.health?.msg}; router parked ${j.router?.parked}; demo ${j.demoRun ? "running" : "stopped"}; autoscale ${j.autoscale ? "on" : "off"}`);
    if (!j.demoRun) console.log("WARN|demo is STOPPED — press START (or POST /demo {\"run\":true}) before SURGE");')
  report "$out"
else warn "Scope not running (cd scope && KUBE_CONTEXT=$CTX node server.mjs --live)"; fi

echo
[ "$FAILS" -eq 0 ] && printf '\033[32mpreflight passed\033[0m\n' || printf '\033[31mpreflight: %d check(s) failed\033[0m\n' "$FAILS"
exit "$FAILS"
