#!/usr/bin/env node
// Substrate Scope — a live visualizer for Agent Substrate
// (https://github.com/agent-substrate/substrate) on kagent 1.0.
// Zero dependencies; needs node >= 20.3 (AbortSignal.any) and kubectl on the PATH.
//
//   node server.mjs                        # simulated feed (built into the page)
//   KUBE_CONTEXT=kind-substrate-day node server.mjs --live
//
// Live mode reads the kagent 1.0 controller (kagent 1.0.0-rc2 + Substrate
// 1.0.0-rc.2) over gRPC-Web — SystemService for the Substrate inventory,
// SessionService + A2A ListTasks for chats started anywhere else (the kagent
// UI, Telegram) — and sends chats as A2A 1.0 SendMessage. kubectl supplies
// what the controller does not: WorkerPools (scale / reset), Agents ->
// Harness -> pool, worker pod usage (kubelet stats), and Prometheus metrics
// from atenet-router and ate-api-server through the API server's pod proxy.
//
// Older kagent 0.10 controllers (REST /api/substrate/status) are detected and
// drawn read-only with a banner; anything else is a LOUD banner, never a
// silently blank board.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { join, dirname, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { kagent, STATE, ON_WORKER, deSuffix, ownMessage, sourceOf, replyOf, cpuMillis, bytesOf } from './lib/kagent.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'public');
const LIVE = process.argv.includes('--live');
const PORT = Number(process.env.PORT || 8123);
// Loopback only by default: the board's POST endpoints fire billable chats and
// scale pools, so they must not be reachable from venue Wi-Fi. HOST=0.0.0.0
// to share the board on a LAN (POSTs are logged with their source address).
const HOST = process.env.HOST || '127.0.0.1';
// Pin every kubectl call (and port-forward) to one context so Scope can never
// watch or scale a cluster you didn't point it at.
const KUBE_CONTEXT = process.env.KUBE_CONTEXT || '';
const KCTX = KUBE_CONTEXT ? ['--context', KUBE_CONTEXT] : [];
const KAGENT_NS = process.env.KAGENT_NAMESPACE || 'kagent';
const KAGENT_USER = process.env.KAGENT_USER || 'admin@kagent.dev';
// Pools Scope acts on by default: RESET POOL, the header +/- buttons, SURGE
// targets and AUTOSCALE. Other pools are drawn and can be scaled from their
// own row, but Scope never bounces or autoscales them unasked.
const DEFAULT_POOL = process.env.SCOPE_POOL || 'kagent-default';
const AUTOSCALE_POOLS = (process.env.SCOPE_AUTOSCALE_POOLS || DEFAULT_POOL).split(',').filter(Boolean);
const SURGE_POOLS = (process.env.SCOPE_SURGE_POOLS || DEFAULT_POOL).split(',').filter(Boolean);
const MAX_SLOTS_SHOWN = Number(process.env.SCOPE_MAX_SLOTS || 8);   // bays drawn per worker pod
const BUDGET = Number(process.env.SCOPE_CHAT_BUDGET || 0);           // 0 = no cap on server-sent chats

let kagentApi = process.env.KAGENT_API || '';                        // set by the port-forward below
// Fixed local ports for Scope's own port-forwards (else the first free port,
// re-used on every respawn so the URLs survive a controller/UI pod restart).
const API_PORT = Number(process.env.KAGENT_API_PORT || 0);
const UI_PORT = Number(process.env.KAGENT_UI_PORT || 0);

// ── demo controls survive a Scope restart ───────────────────────────────────
// STOP DEMO, AUTOSCALE and the chat counter live in a small file in the OS
// temp dir (one per PORT), so a restarted Scope does not silently come back
// RUNNING with AUTOSCALE OFF. SCOPE_START_STOPPED=1 always starts stopped.
const STATE_FILE = process.env.SCOPE_STATE_FILE || join(tmpdir(), `substrate-scope-${PORT}.json`);
const saved = (() => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; } })();
// controls are restored only from a recent run (a restart mid-talk), not from
// yesterday's rehearsal
const fresh = saved && Date.now() - (saved.at ?? 0) < 30 * 60_000 ? saved : null;
// instance tag in every messageId Scope (and a stimulate run reporting here)
// sends, so session ingest skips only this Scope's own turns
const INSTANCE = process.env.SCOPE_INSTANCE || saved?.instance || Math.random().toString(36).slice(2, 6);
const OWN = ownMessage(INSTANCE);
const BOOT = { id: Math.random().toString(36).slice(2, 8), at: Date.now() };
function saveState() {
  try { writeFileSync(STATE_FILE, JSON.stringify({ instance: INSTANCE, demoRun, autoscale, chatsSent, at: Date.now() })); } catch {}
}
const kg = kagent({ apiBase: () => kagentApi, user: KAGENT_USER });

const clients = new Set();
const send = ev => {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(line);
};
const readBody = req => new Promise(res => { let b = ''; req.on('data', c => b += c); req.on('end', () => res(b)); });
const json = (res, obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── health banner: never a silently blank board ──────────────────────────────
let health = { level: 'info', msg: 'starting…' };
function setHealth(level, msg, detail, title) {
  if (health.level === level && health.msg === msg) return;
  health = { level, msg, detail, title, at: Date.now() };
  const line = `[scope] ${level.toUpperCase()}: ${msg}${detail ? ` — ${detail}` : ''}`;
  if (level === 'error') console.error(`\x1b[31m${line}\x1b[0m`);
  else if (level === 'warn') console.warn(`\x1b[33m${line}\x1b[0m`);
  else console.log(line);
  send({ type: 'health', ...health });
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
               '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  if (req.method === 'POST') {
    // every mutating call is logged with its source, and a browser page from
    // another origin (any site you have open) may not drive the board
    const from = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '?';
    const origin = req.headers.origin;
    let foreign = false;
    try { foreign = !!origin && new URL(origin).host !== req.headers.host; } catch { foreign = true; }
    if (!['/queue', '/activity'].includes(path) || foreign)
      console.log(`[scope] POST ${path} from ${from}${origin ? ` (origin ${origin})` : ''}${foreign ? ' — REFUSED: foreign origin' : ''}`);
    if (foreign) return json(res, { ok: false, error: 'cross-origin POST refused' }, 403);
  }
  if (path === '/scale' && req.method === 'POST') {
    if (!LIVE) return json(res, { ok: false, error: 'not in --live mode' });
    let b; try { b = JSON.parse(await readBody(req)); } catch { return json(res, { ok: false, error: 'bad request' }); }
    const pool = poolByName(b.pool);
    if (!pool) return json(res, { ok: false, error: `no workerpool ${b.pool ?? DEFAULT_POOL} seen yet` });
    const replicas = Math.max(1, Math.min(8, Number(b.replicas)));
    if (!Number.isFinite(replicas)) return json(res, { ok: false, error: 'bad replicas' });
    const err = await scalePool(pool, replicas, 'manual');
    return json(res, err ? { ok: false, error: err } : { ok: true, pool: pool.name, replicas });
  }
  if (path === '/reset' && req.method === 'POST') {
    // bounce the WorkerPool's worker Deployment (named <pool> on Substrate 1.0,
    // <pool>-deployment before): frees workers wedged by ghost actors;
    // suspended actors are snapshots and survive
    if (!LIVE) return json(res, { ok: false, error: 'not in --live mode' });
    let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch {}
    const pool = poolByName(b.pool);
    if (!pool) return json(res, { ok: false, error: 'no workerpool seen yet' });
    for (const d of [pool.name, `${pool.name}-deployment`]) {
      const r = await run(['rollout', 'restart', `deploy/${d}`, '-n', pool.ns], 15_000);
      if (r.ok) { send({ type: 'reset', pool: pool.name, deployment: d });
                  return json(res, { ok: true, pool: pool.name, deployment: d }); }
      if (!/not ?found/i.test(r.err)) return json(res, { ok: false, error: r.err.slice(0, 200) });
    }
    return json(res, { ok: false, error: `no Deployment ${pool.name} (or ${pool.name}-deployment) in ${pool.ns}` });
  }
  if (path === '/queue' && req.method === 'POST') {
    // stimulate.mjs reports its retry queue and in-flight chats; the board
    // merges them with Scope's own and with atenet-router's parking gauge
    // One entry per CHAT ({id, name, ns, since, phase}); a name-only
    // `waiting` list from an older stimulate is still understood.
    try {
      const b = JSON.parse(await readBody(req));
      const retrying = new Set((b.waiting ?? []).map(w => w.name ?? w));
      stimInflight = (b.inflight ?? []).map((f, i) => ({ id: `stim:${f.id ?? i}`, name: f.name, ns: f.ns || KAGENT_NS,
        contextId: typeof f.contextId === 'string' ? f.contextId : undefined,
        since: Number(f.since) || Date.now(),
        phase: f.phase === 'retry' || (!f.phase && retrying.has(f.name)) ? 'retry' : 'sent' }));
      stimSeenAt = Date.now();
      computeQueue();
      return json(res, { ok: true });
    } catch { return json(res, { ok: false }, 400); }
  }
  if (path === '/demo') {
    // master kill switch: stimulate.mjs polls this and stops dispatching real
    // (billable) chats when run=false; surge and the drawer respect it too
    if (req.method === 'POST') {
      const was = demoRun;
      try { demoRun = !!JSON.parse(await readBody(req)).run; } catch { demoRun = !demoRun; }
      if (!demoRun) stopInflight();
      if (demoRun && !was) rebaseRouter('START');   // the header counts from START, not from old rehearsals
      saveState();
      send({ type: 'demo_state', run: demoRun });
      return json(res, { ok: true, run: demoRun });
    }
    // yield: a presenter chat is in flight (or just finished): the load
    // generator holds new dispatches so TALK TO IT is not parked behind it
    return json(res, { run: demoRun, yield: Date.now() < presenterUntil });
  }
  if (path === '/activity' && req.method === 'POST') {
    try { recordActivity(JSON.parse(await readBody(req))); return json(res, { ok: true }); }
    catch { return json(res, { ok: false }, 400); }
  }
  if (path === '/chat' && req.method === 'POST') {
    // the drawer's "talk to the agent": one real chat, which restores the
    // actor — activation you can watch happen on the board
    if (!LIVE || mode !== 'rc2') return json(res, { ok: false, error: `chat needs --live against a kagent 1.0 controller (mode: ${mode})` });
    if (!demoRun) return json(res, { ok: false, error: 'demo is stopped (STOP DEMO)' });
    try {
      const { ns, agent, text, wait, contextId } = JSON.parse(await readBody(req));
      if (!agent || !text) throw new Error('bad request');
      // a session chip's drawer continues THAT session (A2A contextId = the
      // kagent Session id; an unknown one fails with -32001 task not found)
      if (contextId && !/^[0-9a-f-]{36}$/i.test(contextId)) throw new Error('bad contextId');
      const p = chatWithAgent(ns || KAGENT_NS, agent, String(text).slice(0, 1000), 'you', { contextId });
      if (wait) return json(res, await p);
      const early = await Promise.race([p, sleep(50).then(() => null)]);   // budget / stop refusals
      return json(res, early && !early.ok && early.refused ? early : { ok: true });
    } catch { return json(res, { ok: false }, 400); }
  }
  if (path === '/surge' && req.method === 'POST') {
    if (!LIVE || mode !== 'rc2') return json(res, { ok: false, error: `surge needs --live against a kagent 1.0 controller (mode: ${mode})` });
    if (!demoRun) return json(res, { ok: false, error: 'demo is STOPPED — press START first' });
    return json(res, { ok: true, ...(await surge()) });
  }
  if (path === '/autoscale' && req.method === 'POST') {
    try { autoscale = !!JSON.parse(await readBody(req)).on; } catch { autoscale = !autoscale; }
    for (const s of Object.values(asState)) { s.up = 0; s.down = 0; s.win.length = 0; }
    saveState();
    send({ type: 'autoscale_state', on: autoscale, pools: AUTOSCALE_POOLS });
    return json(res, { ok: true, on: autoscale, pools: AUTOSCALE_POOLS });
  }
  // ── read-only JSON for curl / stimulate.mjs / preflight.sh ─────────────────
  if (path === '/agents') {
    const pool = url.searchParams.get('pool') || DEFAULT_POOL;
    const inPool = p => pool === 'all' || p === pool;
    const list = Object.entries(agentRoutes).filter(([, r]) => r.ready && inPool(r.pool))
      .map(([name, r]) => ({ ns: r.ns, name, pool: r.pool, harness: r.harness }));
    const pools = (state.lastSnap?.workerPools ?? []).filter(p => inPool(p.name));
    return json(res, { api: kagentApi, mode, pool, instance: INSTANCE, agents: list,
                       workers: pools.reduce((s, p) => s + (p.ready ?? 0), 0),
                       slots: pools.reduce((s, p) => s + (p.slots ?? 0), 0) });
  }
  if (path === '/session-history') {
    // a session chip's drawer: that one conversation, read back from kagent
    // (A2A ListTasks filtered by contextId) — for sessions Scope did not see
    // live: an earlier run, the kagent UI, Telegram
    const agent = url.searchParams.get('agent'), ctx = url.searchParams.get('ctx');
    if (!LIVE || mode !== 'rc2' || !agent || !/^[0-9a-f-]{36}$/i.test(ctx ?? '')) return json(res, { ok: false, items: [] });
    try {
      const ns = agentRoutes[agent]?.ns ?? KAGENT_NS;
      const items = (await kg.sessionHistory(ns, agent, ctx)).map(({ messageId, ...e }) =>
        ({ ...e, via: OWN.test(messageId ?? '') ? (/^surge-/.test(messageId) ? 'surge' : /^stim-/.test(messageId) ? 'stimulator' : 'scope') : e.via }));
      return json(res, { ok: true, items, creator: creators.get(ctx) ?? null });
    } catch (e) { return json(res, { ok: false, items: [], error: String(e.message).slice(0, 160) }); }
  }
  if (path === '/status') return json(res, { mode, version: versions, health, snapshot: state.lastSnap ?? null,
                                             router: routerStats, queue: lastQueue, autoscale, demoRun, chats: chatsSent });
  if (path === '/metrics.json') return json(res, { points: metrics.slice(-100), basis: telemetryBasis(), router: routerStats });
  if (path === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    clients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'mode', live: LIVE, source: mode })}\n\n`);
    if (LIVE) replayState(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const file = path === '/' ? '/index.html' : path;
  if (file.includes('..')) { res.writeHead(400); return res.end(); }
  try {
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'text/plain; charset=utf-8' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});

// ── kubectl helpers ──────────────────────────────────────────────────────────
function run(args, timeout = 10_000) {
  return new Promise(resolve => execFile('kubectl', [...KCTX, ...args], { timeout, maxBuffer: 64 << 20 },
    (err, stdout, stderr) => resolve(err ? { ok: false, err: String(stderr || err.message) } : { ok: true, out: stdout })));
}
async function kubectl(args, timeout) {
  const r = await run(args, timeout);
  if (!r.ok) return null;
  try { return JSON.parse(r.out); } catch { return null; }
}
const raw = async (path, timeout = 6000) => {
  const r = await run(['get', '--raw', path, `--request-timeout=${Math.ceil(timeout / 1000)}s`], timeout + 1000);
  return r.ok ? r.out : null;
};

// ── cluster model (kubectl side) ─────────────────────────────────────────────
const state = { pools: {}, lastSnap: null, lastInv: null };
let agentRoutes = {};          // agent -> { ns, pool, harness, ready, description }
let booking = { cpu: 1000, mem: 2 ** 30, source: 'kagent default (cpu 1 / memory 1Gi)' };
let versions = {};
const poolByName = name => state.pools[name || DEFAULT_POOL] ?? (name ? null : Object.values(state.pools)[0]) ?? null;

async function refreshKube() {
  const [ag, hs, wp] = await Promise.all([
    kubectl(['get', 'agents.api.kagent.dev', '-A', '-o', 'json']),
    kubectl(['get', 'harnesses.api.kagent.dev', '-A', '-o', 'json']),
    kubectl(['get', 'workerpools.ate.dev', '-A', '-o', 'json']),
  ]);
  if (wp) {
    const pools = {};
    for (const p of wp.items ?? []) {
      const req = p.spec?.template?.resources?.requests ?? null;
      const lim = p.spec?.template?.resources?.limits ?? null;
      pools[p.metadata.name] = {
        name: p.metadata.name, ns: p.metadata.namespace, replicas: p.spec?.replicas ?? 0,
        ready: p.status?.readyReplicas ?? 0, workerImage: p.spec?.workerImage ?? p.spec?.ateomImage ?? '',
        requests: req ? { cpu: cpuMillis(req.cpu), mem: Math.round(bytesOf(req.memory) / 2 ** 20) } : null,
        limits: lim ? { cpu: cpuMillis(lim.cpu), mem: Math.round(bytesOf(lim.memory) / 2 ** 20) } : null,
      };
    }
    state.pools = pools;
    const img = (pools[DEFAULT_POOL] ?? Object.values(pools)[0])?.workerImage ?? '';
    versions.substrate = (img.split(':').pop() || versions.substrate || '').replace(/^v(?=\d)/, '');
  }
  if (ag && hs) {
    const poolOf = new Map((hs.items ?? []).map(h => [`${h.metadata.namespace}/${h.metadata.name}`,
      h.spec?.substrate?.workerPoolRef?.name ?? null]));
    const routes = {};
    for (const a of ag.items ?? []) {
      const ns = a.metadata.namespace, harness = a.spec?.harnessRef?.name ?? null;
      routes[a.metadata.name] = {
        ns, harness, pool: poolOf.get(`${ns}/${harness}`) ?? null,
        ready: (a.status?.conditions ?? []).some(c => c.type === 'Ready' && c.status === 'True'),
        description: a.spec?.template?.inline?.description ?? '',
      };
    }
    agentRoutes = routes;
  }
}

// Each actor is booked on a worker at its runtime LIMITS (Substrate placement
// compares limits with the worker's capacity). kagent sets those from the
// controller config's runtimeDefaults.
async function refreshBooking() {
  const cm = await kubectl(['get', 'configmap', 'kagent-controller', '-n', KAGENT_NS, '-o', 'json']);
  const y = cm?.data?.['controller.yaml'] ?? '';
  const block = y.split(/\nruntimeDefaults:\n/)[1]?.split(/\n\S/)[0] ?? '';
  const cpu = block.match(/\n?\s{2}cpu:\s*"?([^"\n]+)"?/)?.[1];
  const mem = block.match(/\n?\s{2}memory:\s*"?([^"\n]+)"?/)?.[1];
  if (cpu && mem) booking = { cpu: cpuMillis(cpu), mem: bytesOf(mem),
    source: `kagent-controller runtimeDefaults (limits): cpu ${cpu} / memory ${mem}` };
}

// slots a worker can host = what its capacity fits at one actor's booking.
// A worker still booting reports no capacity yet: size it like its pool's
// pods (the WorkerPool's pod limits at the same booking), so a scale-up does
// not draw "1 slot" pods for a few polls and then re-flow the bays.
function poolFit(poolName) {
  const lim = state.pools[poolName]?.limits;
  if (!lim?.cpu || !lim?.mem) return null;
  const n = Math.min(Math.floor(lim.cpu / booking.cpu), Math.floor(lim.mem * 2 ** 20 / booking.mem));
  return n > 0 ? n : null;
}
function slotsFor(w) {
  const c = w.status?.capacity ?? {};
  if (!c.cpu_millicores && !c.memory_bytes && !c.actors) return poolFit(w.worker_pool) ?? 1;
  const fits = [c.cpu_millicores ? Math.floor(c.cpu_millicores / booking.cpu) : Infinity,
                c.memory_bytes ? Math.floor(c.memory_bytes / booking.mem) : Infinity,
                c.actors || Infinity];
  const n = Math.min(...fits);
  return Number.isFinite(n) ? Math.max(n, 0) : 1;
}
const totalSlots = () => (state.lastSnap?.workerPools ?? []).reduce((s, p) => s + (p.slots ?? 0), 0);

// ── controller connection + detection ───────────────────────────────────────
let mode = 'none';             // rc2 | legacy | none
// kubectl runs under a tiny sh guard that holds a pipe from Scope: if Scope
// dies in ANY way (even kill -9), the pipe closes and the guard kills its
// kubectl, so no port-forward is left orphaned. A respawn re-uses the local
// port it had (or the fixed one), so URLs survive a pod restart; only if that
// port is taken does it fall back to a free one.
const GUARD = 'exec 3<&0; kubectl "$@" </dev/null & k=$!; trap \'kill $k 2>/dev/null\' TERM INT; '
            + '(read _ <&3; kill $k 2>/dev/null) & r=$!; wait $k; s=$?; kill $r 2>/dev/null; exit $s';
function forward(svc, remote, onPort, fixed = 0, last = 0) {
  const want = fixed || last;
  const c = spawn('sh', ['-c', GUARD, 'sh', ...KCTX, 'port-forward', '-n', KAGENT_NS, svc, `${want || ''}:${remote}`],
                  { stdio: ['pipe', 'pipe', 'pipe'] });
  let port = 0, bindFail = false;
  c.stdout.on('data', d => {
    const m = String(d).match(/Forwarding from 127\.0\.0\.1:(\d+)/);
    if (m && !port) { port = Number(m[1]); onPort(port); }
  });
  c.stderr.on('data', d => {
    if (/address already in use|unable to listen/i.test(d)) bindFail = true;
    if (!/Handling connection|error copying/.test(d)) console.warn(`[port-forward ${svc}] ${String(d).trim()}`);
  });
  c.on('exit', () => {
    children.delete(c);
    if (shuttingDown) return;
    const next = port || (bindFail && !fixed ? 0 : want);
    if (bindFail && want && !fixed) console.warn(`[port-forward ${svc}] local port ${want} is taken — using a free port (the URL changes)`);
    setTimeout(() => forward(svc, remote, onPort, fixed, next), 2000);   // survive pod restarts
  });
  children.add(c);
}
const children = new Set();
let shuttingDown = false;
const killChildren = () => { for (const c of children) { try { c.stdin.end(); c.kill(); } catch {} } };
process.on('exit', () => { shuttingDown = true; killChildren(); });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => {
  shuttingDown = true;
  killChildren();
  process.exit(0);
});

async function detect() {
  try {
    const v = await kg.version();
    if (!v?.kagent_version) throw new Error('GetVersion returned no kagent_version');
    versions.kagent = v.kagent_version;
    if (mode !== 'rc2') console.log(`controller: kagent ${v.kagent_version} (${v.git_commit}) — gRPC-Web SystemService`);
    mode = 'rc2';
    return true;
  } catch (e) {
    let restInfo = '';
    try {
      const r = await fetch(`${kagentApi}/api/substrate/status`, { signal: AbortSignal.timeout(4000) });
      const body = await r.text();
      if (r.ok && body.trim().startsWith('{') && JSON.parse(body)?.data) {
        mode = 'legacy';
        setHealth('warn', 'kagent 0.x controller detected (REST /api/substrate/status). This Scope targets kagent 1.0 — board is read-only, chat/surge disabled.');
        return true;
      }
      restInfo = r.ok && !body.trim() ? '/api/substrate/status answered an EMPTY 200 (kagent 1.0 has no REST API)'
                                       : `/api/substrate/status → HTTP ${r.status}`;
    } catch (e2) { restInfo = `controller unreachable at ${kagentApi}: ${e2.cause?.code ?? e2.message}`; }
    mode = 'none';
    setHealth('error', `cannot read the Substrate inventory: gRPC-Web SystemService/GetVersion failed (${String(e.message).slice(0, 160)}); ${restInfo}`);
    return false;
  }
}

// ── snapshot: the board's shape, from the rc2 inventory ─────────────────────
const slotMaps = new Map();    // workerPod -> Map(actorId -> slot index), keeps bays stable
let invFailures = 0;
function mapSnapshot(inv) {
  // ateapi keeps an ActorTemplate (and its Suspended actors) after the kagent
  // Agent that made it is deleted. Once the Agent list is known, draw only
  // agents that exist, so the board's count matches `kubectl get agents`.
  // An orphan still holding a worker stays visible: that bay is really busy.
  const known = new Set(Object.keys(agentRoutes));
  const live = n => !known.size || known.has(n);
  const actors = inv.actors.map(x => ({
    actorId: x.metadata?.name,
    actorTemplateName: deSuffix(x.actor_template?.name),
    actorTemplateNamespace: x.actor_template?.atespace || KAGENT_NS,
    status: STATE[x.status?.state] ?? 'Unknown',
    workerPod: x.status?.worker_assignment?.worker_pod ?? null,
    workerPool: x.status?.worker_assignment?.worker_pool ?? null,
    updatedAt: x.metadata?.update_time,
    // 1 = created (CreateSession pre-creates a Suspended actor) but never run
    version: Number(x.metadata?.version ?? 0),
  })).filter(a => live(a.actorTemplateName) || (a.workerPod && ON_WORKER.has(a.status)));
  // workers -> slots. One bay per slot; actors on a pod keep their slot.
  const ws = [...inv.workers].sort((a, b) => (a.worker_pool + a.worker_pod).localeCompare(b.worker_pool + b.worker_pod));
  const workers = [], poolSlots = {}, livePods = new Set();
  for (const w of ws) {
    const pod = w.worker_pod;
    livePods.add(pod);
    const on = actors.filter(a => a.workerPod === pod && ON_WORKER.has(a.status));
    const slots = slotsFor(w);
    const shown = Math.max(Math.min(slots, MAX_SLOTS_SHOWN), on.length, 1);
    const map = slotMaps.get(pod) ?? new Map();
    for (const id of [...map.keys()]) if (!on.some(a => a.actorId === id)) map.delete(id);
    for (const a of on) if (!map.has(a.actorId)) {
      const used = new Set(map.values());
      let i = 0; while (used.has(i)) i++;
      map.set(a.actorId, i);
    }
    slotMaps.set(pod, map);
    const byIdx = new Map([...map.entries()].map(([id, i]) => [i, on.find(a => a.actorId === id)]));
    const p = poolSlots[w.worker_pool] ??= { slots: 0, perWorker: poolFit(w.worker_pool) ?? slots, workers: 0, shown };
    p.slots += slots; p.workers++;
    for (let i = 0; i < Math.max(shown, ...[...map.values()].map(v => v + 1)); i++) {
      const a = byIdx.get(i);
      workers.push({ workerNamespace: w.worker_namespace, workerPool: w.worker_pool, workerPod: `${pod}#${i}`,
                     pod, slot: i, slots, state: w.status?.state,
                     actorId: a?.actorId, actorTemplate: a?.actorTemplateName, status: a?.status });
    }
  }
  for (const pod of [...slotMaps.keys()]) if (!livePods.has(pod)) slotMaps.delete(pod);

  const byAgent = new Map();
  for (const t of inv.summary?.actor_templates ?? []) {
    const name = deSuffix(t.metadata?.name);
    if (!live(name)) continue;
    const g = t.status?.golden_snapshot_status ?? {};
    const phase = g.golden_tag?.name ? 'Ready' : g.error_message ? 'Failed' : 'Pending';
    if (byAgent.has(name) && byAgent.get(name).phase === 'Ready') continue;
    byAgent.set(name, { namespace: t.metadata?.atespace || KAGENT_NS, name, phase,
                        goldenTime: g.snapshot_time, error: g.error_message || undefined });
  }
  const actorTemplates = [...byAgent.values()];
  // a template with no session yet still deserves a chip: its golden snapshot
  const seen = new Set(actors.map(x => x.actorTemplateName));
  for (const t of actorTemplates)
    if (!seen.has(t.name)) actors.push({ actorId: `golden-${t.name}`, actorTemplateName: t.name,
                                         actorTemplateNamespace: t.namespace, status: 'Suspended' });
  const workerPools = (inv.summary?.worker_pools ?? []).map(p => {
    const name = p.ref?.name, k = state.pools[name];
    const spec = p.resource?.value?.spec ?? {}, st = p.resource?.value?.status ?? {};
    return { namespace: p.ref?.namespace, name, replicas: k?.replicas ?? spec.replicas ?? 0,
             ready: k?.ready ?? st.readyReplicas ?? 0, workerImage: spec.workerImage ?? '',
             slots: poolSlots[name]?.slots ?? 0, slotsPerWorker: poolSlots[name]?.perWorker ?? null,
             slotsShown: poolSlots[name]?.shown ?? null, requests: k?.requests ?? null, limits: k?.limits ?? null };
  }).sort((a, b) => (a.name === DEFAULT_POOL ? -1 : b.name === DEFAULT_POOL ? 1 : a.name.localeCompare(b.name)));
  const agentPools = Object.fromEntries(Object.entries(agentRoutes).map(([n, r]) => [n, r.pool]));
  return { enabled: true, controller: 'rc2', workerPools, actorTemplates, actors, workers, agentPools,
           agentRoutes, booking: { cpuM: booking.cpu, memMi: Math.round(booking.mem / 2 ** 20), source: booking.source },
           counts: { sessions: sessionCount, actors: Number(inv.summary?.actor_count ?? inv.actors.length), workers: Number(inv.summary?.worker_count ?? inv.workers.length),
                     running: Number(inv.summary?.running_actor_count ?? 0), busyWorkers: Number(inv.summary?.busy_worker_count ?? 0) },
           ateApiError: inv.ateApiError || undefined };
}

// kagent 0.10 REST snapshot (read-only fallback)
async function legacyStatus() {
  try {
    const r = await fetch(`${kagentApi}/api/substrate/status`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    const s = j?.data;
    if (!s) return null;
    for (const a of s.actors ?? []) a.actorTemplateName = deSuffix(a.actorTemplateName);
    for (const w of s.workers ?? []) w.actorTemplate = deSuffix(w.actorTemplate);
    for (const t of s.actorTemplates ?? []) t.name = deSuffix(t.name);
    return { ...s, controller: 'legacy' };
  } catch { return null; }
}

let polling = false;
async function poll() {
  if (polling || !kagentApi) return;
  polling = true;
  try {
    let snap = null;
    if (mode === 'none' && !(await detect())) return;
    if (mode === 'rc2') {
      try {
        const inv = await kg.inventory();
        state.lastInv = inv;
        snap = mapSnapshot(inv);
        invFailures = 0;
      } catch (e) {
        if (++invFailures >= 3) { mode = 'none'; await detect(); }
        if (invFailures >= 3 && mode === 'rc2')
          setHealth('error', `Substrate inventory call failing: ${String(e.message).slice(0, 200)}`);
        return;
      }
    } else if (mode === 'legacy') snap = await legacyStatus();
    if (!snap) return;
    checkHealth(snap);
    state.lastSnap = { type: 'snapshot', ...snap };
    send(state.lastSnap);
  } finally { polling = false; }
}

let shortSince = null, zeroSince = null;
function checkHealth(snap) {
  if (snap.controller === 'legacy') return;
  const readyPods = Object.values(state.pools).reduce((s, p) => s + (p.ready ?? 0), 0);
  const readyAgents = Object.values(agentRoutes).filter(r => r.ready).length;
  if (snap.ateApiError) return setHealth('warn', `kagent reports an ate-api error — counts may be short`, snap.ateApiError);
  if (!snap.workers.length && readyPods > 0)
    return setHealth('error', `SystemService reports 0 Substrate workers, but WorkerPools have ${readyPods} ready pod(s) — inventory is lying or ate-api is unreachable from the controller`);
  if (!snap.actorTemplates.length && readyAgents > 0)
    return setHealth('error', `SystemService reports 0 ActorTemplates, but ${readyAgents} Agent(s) are Ready — inventory is empty`);
  if (!snap.workers.length && !Object.keys(state.pools).length)
    return setHealth('warn', 'no WorkerPools found in this cluster');
  // the demo pool (SURGE / AUTOSCALE / TALK TO IT) must have workers; another
  // pool's pods must not hide that it has none
  const dp = state.pools[DEFAULT_POOL];
  if (dp) {
    const now = Date.now();
    // Authority = the inventory (workers ateapi reports ACTIVE), the same count
    // the board draws. The WorkerPool's kubectl `ready` is re-read every 10s and
    // lags a RESET POOL rollout, which raised a false NO WORKERS banner on stage.
    const pods = snap.workers.filter(w => w.workerPool === DEFAULT_POOL && w.slot === 0
                                          && (!w.state || /ACTIVE/.test(w.state))).length;
    if (!pods) zeroSince ??= now; else zeroSince = null;
    if (zeroSince && now - zeroSince > 3000) {   // a short dip during RESET POOL is not an outage
      return setHealth('error', `pool ${DEFAULT_POOL} has NO WORKERS (0 active of ${dp.replicas} wanted) — its agents' chats park and retry`,
        `fix: kubectl --context ${KUBE_CONTEXT || '<ctx>'} scale workerpools.ate.dev ${DEFAULT_POOL} -n ${dp.ns} --replicas=1 (or AUTOSCALE ON)`, 'DEMO POOL HAS NO WORKERS');
    }
    if (pods < dp.replicas) { shortSince ??= now; } else shortSince = null;
    if (shortSince && now - shortSince > 30_000)
      return setHealth('warn', `pool ${DEFAULT_POOL}: only ${pods} of ${dp.replicas} worker pods active for over 30s`, undefined, 'POOL SHORT OF WORKERS');
  }
  setHealth('ok', `kagent ${versions.kagent ?? '?'} · substrate ${versions.substrate ?? '?'} · ${snap.workerPools.length} pool(s), ${readyAgents} agents`);
}

// Drawer text is capped; say so instead of ending mid-word.
const clip = (t, n = 600) => t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + ' …' : t;

// ── Prometheus: atenet-router parking + ate-api scheduler ───────────────────
// Read through the API server's pod proxy (no port-forward to keep alive).
// Names verified on rc2: agentgateway_substrate_request_parking_active
// (router gauge), agentgateway_atenet_router_route_duration_seconds{
// ate_router_outcome}, ate_scheduler_assignment_duration_seconds{
// ate_scheduler_outcome="no_capacity", ate_workerpool_name} (ate-api-server).
function parseProm(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line || line[0] === '#') continue;
    const m = line.match(/^([a-zA-Z_:][\w:]*)(\{(.*)\})?\s+(\S+)/);
    if (!m) continue;
    const labels = {};
    for (const l of (m[3] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]] = l[2];
    out.push({ name: m[1], labels, value: Number(m[4]) });
  }
  return out;
}
let scrapeTargets = { router: [], api: [], at: 0 };
async function discoverScrape() {
  const pods = await kubectl(['get', 'pods', '-n', 'ate-system', '-o', 'json']);
  const pick = app => (pods?.items ?? []).filter(p => p.metadata.labels?.app === app && p.status?.phase === 'Running')
    .map(p => ({ name: p.metadata.name, port: p.metadata.annotations?.['prometheus.io/port']
      ?? p.spec.containers.flatMap(c => c.ports ?? []).find(x => /metrics|prometheus/.test(x.name ?? ''))?.containerPort }))
    .filter(p => p.port);
  scrapeTargets = { router: pick('atenet-router'), api: pick('ate-api-server'), at: Date.now() };
}
let routerBase = null;         // counter values at Scope start / last SURGE
const rebaseRouter = why => { routerBase = routerBase ? { ...routerBase, pending: { why } } : null; };
let routerStats = { ok: false, parked: null, rejected: null, outcomes: {}, noCapacity: null, assigned: {}, error: 'not scraped yet' };
async function scrapeRouter() {
  if (Date.now() - scrapeTargets.at > 30_000 || !scrapeTargets.router.length) await discoverScrape();
  const scrape = async t => parseProm(await raw(`/api/v1/namespaces/ate-system/pods/${t.name}:${t.port}/proxy/metrics`, 4000) ?? '');
  const [r, a] = await Promise.all([Promise.all(scrapeTargets.router.map(scrape)), Promise.all(scrapeTargets.api.map(scrape))]);
  const rs = r.flat(), as = a.flat();
  const parkedSeries = rs.filter(s => /parking_active$/.test(s.name));
  const rejSeries = rs.filter(s => /parking_rejected/.test(s.name) || /parking.*(reject|timeout|expired)/.test(s.name));
  const outcomes = {};
  for (const s of rs.filter(s => /atenet_router_route_duration_seconds_count$/.test(s.name))) {
    const k = s.labels.ate_router_outcome ?? '?';
    outcomes[k] = (outcomes[k] ?? 0) + s.value;
  }
  // no_capacity carries no ate_workerpool_name on rc.2 (verified): a total
  const assigned = {};
  let schedPresent = false, noCapacity = 0;
  for (const s of as.filter(s => s.name === 'ate_scheduler_assignment_duration_seconds_count')) {
    schedPresent = true;
    if (s.labels.ate_scheduler_outcome === 'no_capacity') noCapacity += s.value;
    if (s.labels.ate_scheduler_outcome === 'assigned') {
      const pool = s.labels.ate_workerpool_name ?? '?';
      assigned[pool] = (assigned[pool] ?? 0) + s.value;
    }
  }
  // the counters are cumulative since the router / ate-api pod started (old
  // rehearsals included): the board shows them as deltas since Scope started
  // or since the last SURGE
  const totalFails = Object.entries(outcomes).filter(([k]) => k !== 'ok').reduce((s, [, v]) => s + v, 0);
  if (rs.length) {
    const base = why => ({ fails: totalFails, noCapacity, at: Date.now(), why });
    if (!routerBase) routerBase = base('Scope start');
    else if (routerBase.pending) routerBase = base(routerBase.pending.why);
    else if (totalFails < routerBase.fails || (schedPresent && noCapacity < routerBase.noCapacity)) routerBase = base('counter reset');
  }
  routerStats = {
    ok: rs.length > 0, at: Date.now(),
    failsTotal: totalFails, failsSince: routerBase ? totalFails - routerBase.fails : null,
    noCapacitySince: routerBase && schedPresent ? noCapacity - routerBase.noCapacity : null,
    since: routerBase?.at ?? null, sinceWhy: routerBase?.why ?? null,
    routerPods: scrapeTargets.router.map(t => `${t.name}:${t.port}`), apiPods: scrapeTargets.api.map(t => `${t.name}:${t.port}`),
    parked: parkedSeries.length ? parkedSeries.reduce((s, x) => s + x.value, 0) : null,
    parkedMetric: parkedSeries[0]?.name ?? null,
    rejected: rejSeries.length ? rejSeries.reduce((s, x) => s + x.value, 0) : null,
    rejectedMetric: rejSeries[0]?.name ?? null,
    outcomes, schedPresent, noCapacity: schedPresent ? noCapacity : null, assigned,
    error: rs.length ? undefined : 'atenet-router /metrics not reachable through the API server pod proxy',
  };
  // chats this board knows are in flight: while any are, parked requests may
  // be ours, so the lane does not call them "from other clients"
  routerStats.ownInflight = inflight.size + (Date.now() - stimSeenAt < 15_000 ? stimInflight.length : 0);
  send({ type: 'router', ...routerStats });
}

// ── metrics: kubelet stats (no metrics-server needed) ───────────────────────
const metrics = [];
const METRICS_MAX = 1200;      // ~1h at 3s
let nodes = [];
// Always-on baseline: what ONE agent would reserve as an always-on pod. kagent
// 1.0 has no always-on agents to measure, so this is an explicit, labelled
// assumption: kagent v0.10.5's default Agent Deployment REQUESTS
// (go/core/internal/controller/translator/agent/deployments.go: requests
// cpu 100m / memory 384Mi; limits 2000m / 1Gi). Override with UNIT_CPU_M /
// UNIT_MEM_MI / UNIT_SOURCE.
const unit = { cpu: Number(process.env.UNIT_CPU_M) || 100, mem: Number(process.env.UNIT_MEM_MI) || 384,
               source: process.env.UNIT_SOURCE || (process.env.UNIT_CPU_M || process.env.UNIT_MEM_MI
                 ? 'UNIT_CPU_M / UNIT_MEM_MI (set by operator)'
                 : 'kagent v0.10.5 always-on Agent Deployment default requests (100m CPU / 384Mi)') };
// Like for like: the chart compares a pool's reserved capacity with what ITS
// agents would reserve always-on. A pool without pod requests has no measured
// reservation, so it is left out of BOTH lines (and named in the footnote)
// rather than padded with a guessed slots × unit figure — unless no pool sets
// requests, in which case every pool uses that labelled fallback.
function chartPools() {
  const all = state.lastSnap?.workerPools ?? [];
  const measured = all.filter(p => p.requests);
  return { all, inChart: measured.length ? measured : all, fallback: !measured.length };
}
function telemetryBasis() {
  const { all, inChart, fallback } = chartPools();
  const agentsIn = name => Object.values(agentRoutes).filter(r => r.ready && r.pool === name).length;
  const pools = all.map(p => ({
    name: p.name, workers: p.ready, slots: p.slots, slotsPerWorker: p.slotsPerWorker,
    requests: p.requests, limits: p.limits, agents: agentsIn(p.name), inChart: inChart.includes(p),
    basis: !inChart.includes(p) ? `left out of the chart: no pod requests set, so nothing measured to compare (${agentsIn(p.name)} agents)`
         : p.requests ? `worker pod requests ${p.requests.cpu}m / ${p.requests.mem}Mi × pods, vs its ${agentsIn(p.name)} agents`
                      : `no pod requests set — slots × unit (${p.slots} × ${unit.cpu}m / ${unit.mem}Mi), vs its ${agentsIn(p.name)} agents`,
  }));
  return { unit, fallback, booking: { cpuM: booking.cpu, memMi: Math.round(booking.mem / 2 ** 20), source: booking.source }, pools };
}
async function sampleMetrics() {
  const snap = state.lastSnap;
  if (!snap || snap.controller !== 'rc2') return;
  if (!nodes.length) nodes = ((await kubectl(['get', 'nodes', '-o', 'json']))?.items ?? []).map(n => n.metadata.name);
  const { inChart } = chartPools();
  const charted = new Set(inChart.map(p => p.name));
  const workerPods = new Set((state.lastInv?.workers ?? []).filter(w => charted.has(w.worker_pool))
    .map(w => `${w.worker_namespace}/${w.worker_pod}`));
  let wCpu = 0, wMem = 0;
  for (const n of nodes) {
    const s = await raw(`/api/v1/nodes/${n}/proxy/stats/summary`, 5000);
    if (!s) continue;
    let j; try { j = JSON.parse(s); } catch { continue; }
    for (const p of j.pods ?? [])
      if (workerPods.has(`${p.podRef.namespace}/${p.podRef.name}`)) {
        wCpu += ((p.cpu ?? {}).usageNanoCores ?? 0) / 1e6;
        wMem += ((p.memory ?? {}).workingSetBytes ?? 0) / 2 ** 20;
      }
  }
  let resCpu = 0, resMem = 0;
  for (const p of inChart) {
    const pods = (state.lastInv?.workers ?? []).filter(w => w.worker_pool === p.name).length;
    if (p.requests) { resCpu += p.requests.cpu * pods; resMem += p.requests.mem * pods; }
    else { resCpu += p.slots * unit.cpu; resMem += p.slots * unit.mem; }
  }
  const agents = Object.values(agentRoutes).filter(r => r.ready && charted.has(r.pool)).length
              || Object.values(agentRoutes).filter(r => r.ready).length || snap.actorTemplates.length;
  const active = snap.workers.filter(w => w.actorId).length;
  const point = {
    t: Date.now(), wCpu: Math.round(wCpu), wMem: Math.round(wMem),
    resCpu: Math.round(resCpu), resMem: Math.round(resMem),
    benchCpu: agents * unit.cpu, benchMem: agents * unit.mem, unitCpu: unit.cpu, unitMem: unit.mem,
    active, slots: totalSlots(), queued: lastQueue.waiting.length, parked: routerStats.parked ?? 0,
    agents, pods: workerPods.size,
  };
  metrics.push(point);
  if (metrics.length > METRICS_MAX) metrics.shift();
  send({ type: 'metrics', p: point });
  autoscaleTick();
}

// ── autoscaler: demand-driven, per pool, in replicas ────────────────────────
// CPU is the wrong signal: actors are booked by their limits, and LLM turns
// are mostly I/O wait. Demand = actors on the pool's workers + Scope-known
// waiting chats for the pool's agents; replicas = ceil(demand / slots per pod).
let autoscale = fresh?.autoscale ?? false;
// MIN is in pods. The floor exists so one long session never freezes a pool
// (two slots minimum). On Substrate 1.0 a sized worker already holds two
// actors (2 CPU / 2304Mi at kagent's 1 CPU / 1Gi booking), so one pod is it.
const AS = { MIN: Number(process.env.SCOPE_AUTOSCALE_MIN || 1), MAX: 8, COOL_UP: 8_000, COOL_DOWN: 20_000,
             UP_TICKS: 1, DOWN_TICKS: 6, WINDOW: 10 };
const asState = {};
async function scalePool(pool, n, why) {
  const r = await run(['scale', 'workerpools.ate.dev', pool.name, '-n', pool.ns, `--replicas=${n}`], 10_000);
  if (r.ok) pool.replicas = n;
  send({ type: 'autoscale', pool: pool.name, replicas: n, why, ok: r.ok, error: r.ok ? undefined : r.err.slice(0, 160) });
  return r.ok ? null : r.err.slice(0, 200);
}
function autoscaleTick() {
  if (!autoscale) return;
  const snap = state.lastSnap;
  for (const name of AUTOSCALE_POOLS) {
    const pool = state.pools[name], sp = snap?.workerPools.find(p => p.name === name);
    if (!pool || !sp) continue;
    const s = asState[name] ??= { up: 0, down: 0, win: [], last: 0 };
    const per = Math.max(1, sp.slotsPerWorker || 1);
    const active = snap.workers.filter(w => w.workerPool === name && w.actorId).length;
    // waiting = Scope/stimulate chats for this pool's agents with no actor on
    // a worker yet (one per CHAT), or — if more — the router's parked gauge
    // minus what Scope already knows waits elsewhere, while this pool is
    // full (parking only happens when a pool has no room; other clients
    // such as the kagent UI or Telegram park there too)
    const queued = lastQueue.waiting.filter(w => agentRoutes[w.name]?.pool === name).length;
    const full = sp.slots > 0 && active >= sp.slots;
    const elsewhere = lastQueue.waiting.length - queued;
    const parkedHere = full ? Math.max(0, (routerStats.parked ?? 0) - elsewhere) : 0;
    const waitingN = Math.max(queued, parkedHere);
    const demand = active + waitingN;
    s.win.push(demand); if (s.win.length > AS.WINDOW) s.win.shift();
    const clamp = n => Math.min(AS.MAX, Math.max(AS.MIN, n));
    const upTarget = clamp(Math.ceil(demand / per));
    const peak = Math.max(...s.win);
    const downTarget = clamp(Math.ceil(peak / per));
    const cur = pool.replicas;
    const now = Date.now();
    if (cur < AS.MIN) {             // never leave the pool below its floor
      if (now - s.last > AS.COOL_UP) { s.last = now; s.up = 0; s.down = 0;
        scalePool(pool, AS.MIN, `below the autoscaler floor of ${AS.MIN}`); }
      continue;
    }
    if (waitingN > 0 && upTarget > cur) { s.up++; s.down = 0; }
    else if (downTarget < cur) { s.down++; s.up = 0; }
    else { s.up = 0; s.down = 0; }
    if (s.up >= AS.UP_TICKS && upTarget > cur && now - s.last > AS.COOL_UP) {
      s.up = 0; s.last = now;
      scalePool(pool, upTarget, `demand ${demand} (${waitingN} waiting${parkedHere > queued ? ', router-parked' : ''}) ÷ ${per} slots/pod`);
    } else if (s.down >= AS.DOWN_TICKS && downTarget < cur && now - s.last > AS.COOL_DOWN) {
      s.down = 0; s.last = now;
      scalePool(pool, downTarget, `peak demand ${peak} over ${AS.WINDOW * 3}s ÷ ${per} slots/pod`);
    }
  }
}

// ── per-agent activity: prompts, replies, latency ───────────────────────────
// Every entry has an id (boot id + sequence) so a browser that reconnects and
// gets the history replayed can skip what it already shows.
const activity = [];
const ACT_MAX = 400;
let actSeq = 0;
function recordActivity(ev) {
  const e = { t: Date.now(), ...ev, id: `${BOOT.id}-${++actSeq}` };
  activity.push(e);
  if (activity.length > ACT_MAX) activity.shift();
  send({ type: 'activity', e });
}

// ── queue lane: router parking + client retry ───────────────────────────────
// Substrate 1.0 PARKS a request in atenet-router (~5s) while no worker has
// room, then fails it (-32004 through the gateway). So "waiting" has two
// layers: chats still inside SendMessage that have no actor on a worker yet
// (parked in the router), and chats that were refused and sit in a client
// retry backoff. Both are counted per CHAT, not per agent: an agent that is
// already running can have more chats parked behind it.
const inflight = new Map();    // id -> { name, ns, since, phase: 'sent'|'retry', via, ctl }
let stimInflight = [], stimSeenAt = 0;
let lastQueue = { waiting: [] };
function computeQueue() {
  const now = Date.now();
  const onWorker = new Map();  // agent -> actors on a worker now
  for (const w of state.lastSnap?.workers ?? []) if (w.actorTemplate) onWorker.set(w.actorTemplate, (onWorker.get(w.actorTemplate) ?? 0) + 1);
  const parkedNow = (routerStats.parked ?? 0) > 0;
  const stim = now - stimSeenAt < 15_000 ? stimInflight : [];
  const chats = [...[...inflight].map(([id, c]) => ({ id, ...c })), ...stim].sort((a, b) => a.since - b.since);
  const sentBy = new Map();    // agent -> its in-SendMessage chats, oldest first
  const waiting = [];
  for (const c of chats) {
    if (c.phase === 'retry') { waiting.push({ id: c.id, name: c.name, ctx: c.contextId, why: 'retry' }); continue; }
    if (now - c.since <= 1200) continue;                       // give it a poll to land
    (sentBy.get(c.name) ?? sentBy.set(c.name, []).get(c.name)).push(c);
  }
  // the OLDEST chats of an agent are the ones its on-worker actors serve;
  // the rest have no actor yet
  for (const [name, list] of sentBy)
    for (const c of list.slice(onWorker.get(name) ?? 0))
      waiting.push({ id: c.id, name, ctx: c.contextId, why: parkedNow ? 'parked' : 'waiting' });
  const key = JSON.stringify(waiting);
  if (key !== JSON.stringify(lastQueue.waiting)) {
    lastQueue = { waiting };
    send({ type: 'queue', waiting, parked: routerStats.parked, rejected: routerStats.rejected });
  }
}

let demoRun = process.env.SCOPE_START_STOPPED === '1' ? false : (fresh?.demoRun ?? true);   // master switch for anything that costs LLM tokens
let chatsSent = fresh?.chatsSent ?? 0;
let presenterUntil = 0;        // stimulate holds new dispatches while the presenter talks

// STOP DEMO: retry loops stop at once, and chats that have no actor on a
// worker yet (parked in the router, or about to retry) are aborted so they
// cannot be admitted — and billed — after the stop. Turns already running
// are left to finish: they are billed either way, and cutting them mid-turn
// only leaves a failed task behind.
function stopInflight() {
  const waitingIds = new Set(lastQueue.waiting.map(w => w.id));
  for (const [id, c] of inflight) {
    c.cancelled = true;
    if (waitingIds.has(id) || c.phase === 'retry') c.ctl.abort();
  }
}

// ── surge: one real chat at every Ready agent in the surge pools ────────────
async function surge() {
  if (!demoRun) return { fired: 0, accepted: 0, refused: 0 };
  await refreshKube();
  rebaseRouter('SURGE');
  const targets = Object.entries(agentRoutes).filter(([, r]) => r.ready && SURGE_POOLS.includes(r.pool));
  let accepted = 0, refused = 0, stopped = false;
  for (const [name, r] of targets) {
    if (!demoRun) { stopped = true; break; }            // STOP DEMO pressed mid-surge
    const p = chatWithAgent(r.ns, name,                // fire-and-forget, retries inside
      'Explain in about 120 words what you would do first in a production incident.', 'surge');
    const early = await Promise.race([p, sleep(120).then(() => null)]);
    if (early?.refused) refused++; else accepted++;
  }
  return { fired: accepted, accepted, refused, targets: targets.length, stopped };
}

// One real chat: restore -> LLM turn -> checkpoint. ONE logical chat is ONE
// Session (kg.converse creates it up front and retries a pool-full send
// INTO it — before, every retry was a fresh SendMessage and made a new
// Session + actor). { contextId } continues an existing session instead
// (TALK TO IT from a session chip's drawer). Pool-full rejections back off
// with jitter; everything lands in the activity stream, tagged with the
// session (contextId) so the board's session view files it per conversation.
const SESSION_NAMES = { surge: 'Scope · SURGE', you: 'Scope · TALK TO IT' };
async function chatWithAgent(ns, name, prompt, via, { contextId } = {}) {
  if (!demoRun) return { ok: false, refused: true, error: 'demo is stopped (STOP DEMO)' };
  if (BUDGET && chatsSent >= BUDGET) {
    recordActivity({ agent: name, kind: 'error', text: `SCOPE_CHAT_BUDGET ${BUDGET} reached`, via, contextId });
    return { ok: false, refused: true, error: `SCOPE_CHAT_BUDGET ${BUDGET} reached` };
  }
  chatsSent++; saveState();
  const id = `${via === 'surge' ? 'surge' : 'scope'}-${INSTANCE}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const c = { name, ns, since: Date.now(), phase: 'sent', via, ctl: new AbortController(), contextId };
  inflight.set(id, c);
  if (via === 'you') presenterUntil = Infinity;
  computeQueue();
  const t0 = Date.now();
  let prompted = false, waited = false;
  const promptOnce = ctx => { if (prompted) return; prompted = true;
    recordActivity({ agent: name, kind: 'prompt', text: prompt.slice(0, 400), via, contextId: ctx }); };
  try {
    const result = await kg.converse(ns, name, prompt, {
      id, contextId, signal: c.ctl.signal, sessionName: SESSION_NAMES[via] ?? `Scope · ${via}`,
      // the session is known BEFORE the first send: the prompt (and the queue
      // entry) already belong to it
      onSession: ctx => { c.contextId = ctx; promptOnce(ctx); },
      onAttempt: () => { promptOnce(undefined); c.phase = 'sent'; c.since = Date.now(); },
      onRetry: r => {
        if (!waited) {
          waited = true;
          recordActivity({ agent: name, kind: 'queued', via, contextId: c.contextId,
            text: `${r.busy ? 'session busy (a restore is unwinding)' : 'pool full — atenet-router parked it ~5s, then gave up'} (${String(r.error).slice(0, 140)}); retrying in the same session` });
        }
        c.phase = 'retry'; computeQueue();
      },
      // the request died in flight (port-forward or controller restart): the
      // turn may well have run — find its task by messageId and show the reply
      recover: (r, messageId) => recoverTurn(ns, name, messageId, t0, r, via),
      stop: () => { if (!demoRun) c.cancelled = true; return !!c.cancelled; },
    });
    const ms = Date.now() - t0;
    const extra = { ms, via, contextId: result.contextId, turnMs: result.ms, tries: result.tries,
                    ...(result.recovered && { recovered: true }) };
    if (result.sessionError) console.warn(`[scope] CreateSession failed for ${name} (${result.sessionError}) — sent without contextId, same messageId on retries`);
    if (result.ok) recordActivity({ agent: name, kind: 'reply', text: clip(result.text || '(no text)'), ...extra });
    else recordActivity({ agent: name, kind: 'error',
      text: (c.cancelled ? 'stopped (STOP DEMO) — ' : '') + String(result.error ?? 'failed').slice(0, 300), ...extra });
    return { ...result, ms };
  } finally {
    inflight.delete(id);
    if (via === 'you' && ![...inflight.values()].some(x => x.via === 'you')) presenterUntil = Date.now() + 8000;
    computeQueue();
  }
}

// A send that lost its connection: poll A2A ListTasks (through whatever
// controller address the port-forward has now) for the task our messageId
// started, for up to ~60s, and return its outcome as if the send had answered.
async function recoverTurn(ns, name, messageId, t0, failed, via) {
  recordActivity({ agent: name, kind: 'queued', via,
    text: `lost the connection mid-turn (${String(failed.error).slice(0, 80)}) — looking the turn up by messageId` });
  const after = new Date(t0 - 5000).toISOString();
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    let task;
    try { task = await kg.findTask(ns, name, messageId, { after }); } catch { continue; }   // still reconnecting
    if (!task) { if (i >= 5) break; continue; }        // never reached the agent: report the failure
    const st = task.status?.state ?? '';
    if (!TERMINAL.test(st)) continue;
    const text = replyOf(task);
    const bad = /FAILED|REJECTED|CANCELED/.test(st);
    return { ok: !bad, recovered: true, state: st, text, error: bad ? (text || st) : undefined,
             taskId: task.id, contextId: task.contextId, poolFull: false };
  }
  return failed;
}

// ── session ingest: chats started anywhere else (kagent UI, Telegram, MCP) ──
// SessionService/ListSessions finds new sessions and their creator; A2A
// ListTasks (per agent, statusTimestampAfter) returns their turns. Turns whose
// user message carries THIS Scope's messageId prefix (scope-/surge-/stim-
// + instance) are skipped; another Scope's or stimulator's are shown.
const seenTasks = new Map();   // taskId -> last state
const taskSince = new Map();   // agent -> RFC3339 cursor
const creators = new Map();    // contextId -> creator
const sessionStart = Date.now() - 120_000;
const TERMINAL = /COMPLETED|FAILED|CANCELED|REJECTED|INPUT_REQUIRED|AUTH_REQUIRED/;
let sessionCount = null, warnedTrunc = false;
async function pollSessions() {
  if (mode !== 'rc2') return;
  const hot = new Set();
  try {
    const { sessions, truncated } = await kg.sessions();
    sessionCount = sessions.length;
    if (truncated && !warnedTrunc) { warnedTrunc = true;
      console.warn(`[scope] ListSessions: more than ${sessions.length} sessions — the newest are past the page cap; prune old sessions`); }
    for (const s of sessions) {
      const ag = s.agent?.ref?.name;
      if (!ag) continue;
      if (!creators.has(s.context_id || s.id)) {
        creators.set(s.context_id || s.id, s.creator);
        if (new Date(s.created_at).getTime() > sessionStart) hot.add(ag);
      }
      if (new Date(s.updated_at).getTime() > Date.now() - 90_000) hot.add(ag);
    }
  } catch (e) { send({ type: 'ingest', ok: false, error: `ListSessions: ${String(e.message).slice(0, 120)}` }); }
  // an actor that moved recently means a turn happened on that agent
  for (const a of state.lastInv?.actors ?? [])
    if (new Date(a.metadata?.update_time).getTime() > Date.now() - 90_000) hot.add(deSuffix(a.actor_template?.name));
  for (const name of hot) {
    const r = agentRoutes[name];
    if (!r) continue;
    const after = taskSince.get(name) ?? new Date(sessionStart).toISOString();
    let tasks;
    try { tasks = await kg.listTasks(r.ns, name, { after }); } catch { continue; }
    let cursor = after;
    for (const task of tasks) {
      const st = task.status?.state ?? '';
      if (task.status?.timestamp && task.status.timestamp > cursor && TERMINAL.test(st)) cursor = task.status.timestamp;
      const prev = seenTasks.get(task.id);
      if (prev === st) continue;
      seenTasks.set(task.id, st);
      if (seenTasks.size > 2000) seenTasks.delete(seenTasks.keys().next().value);
      const um = (task.history ?? []).find(m => m.role === 'ROLE_USER' && (!m.taskId || m.taskId === task.id));
      if (um && OWN.test(um.messageId ?? '')) continue;              // this Scope's own turn
      const rawText = (um?.parts ?? []).map(p => p.text ?? '').join('');
      const via = sourceOf(um?.messageId, rawText);
      // the doorbell tags Telegram turns "[telegram chat_id=… from=Name]": never show a chat id on the board
      const text = rawText.replace(/^\[telegram chat_id=\S+ from=([^\]]*)\]\s*/, '📱 $1: ');
      const obo = creators.get(task.contextId) ?? null;
      if (prev === undefined && text)
        recordActivity({ agent: name, kind: 'prompt', text: text.slice(0, 400), via, obo, contextId: task.contextId });
      if (TERMINAL.test(st)) {
        const created = Date.parse(task.metadata?.['kagent.dev/a2a/task-created-at'] ?? '');
        const ms = created && task.status?.timestamp ? Date.parse(task.status.timestamp) - created : undefined;
        // an agent that answered through its telegram MCP tool: show what it SENT
        const sent = (task.artifacts ?? []).flatMap(a => a.parts ?? [])
          .filter(p => /send_message$/.test(p.data?.name ?? '') && p.data?.args?.text).map(p => p.data.args.text);
        recordActivity({ agent: name, kind: /FAILED|CANCELED|REJECTED/.test(st) ? 'error' : 'reply',
                         text: clip((sent.length ? '📱 sent: ' + sent.join('\n') : '') || replyOf(task) || st),
                         via, ms, contextId: task.contextId });
      }
    }
    // re-read anything still running next time; otherwise move the cursor on
    const open = tasks.some(t => !TERMINAL.test(t.status?.state ?? ''));
    if (!open) taskSince.set(name, cursor);
  }
}

function replayState(res) {
  const w = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  w({ type: 'health', ...health });
  w({ type: 'versions', ...versions });
  w({ type: 'boot', id: BOOT.id, at: BOOT.at, restored: !!fresh });
  w({ type: 'demo_state', run: demoRun });
  if (activity.length) w({ type: 'activity_history', items: activity.slice(-200) });
  if (metrics.length) w({ type: 'metrics_history', points: metrics });
  w({ type: 'telemetry_basis', ...telemetryBasis() });
  w({ type: 'autoscale_state', on: autoscale, pools: AUTOSCALE_POOLS });
  w({ type: 'router', ...routerStats });
  if (state.lastSnap) w(state.lastSnap);
  w({ type: 'queue', waiting: lastQueue.waiting, parked: routerStats.parked, rejected: routerStats.rejected });
}

const every = (ms, fn) => { const tick = () => Promise.resolve().then(fn).catch(e => console.warn('[scope]', e.message)); tick(); return setInterval(tick, ms); };

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`\x1b[31m[scope] port ${PORT} on ${HOST} is already in use — another Scope is running there. `
    + `Stop it, or start this one with PORT=<other port>.\x1b[0m`);
  else console.error(`\x1b[31m[scope] cannot listen on ${HOST}:${PORT}: ${e.message}\x1b[0m`);
  process.exit(1);
});
server.listen(PORT, HOST, async () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST.includes(':') ? `[${HOST}]` : HOST;
  console.log(`Substrate Scope → http://${shown}:${PORT}  (${LIVE ? `LIVE, context ${KUBE_CONTEXT || '(current)'}` : 'simulated'}; `
    + `listening on ${HOST}${HOST === '127.0.0.1' ? ' only' : ' — reachable from the network'}; instance ${INSTANCE})`);
  if (fresh) console.log(`[scope] restored from the last run (${Math.round((Date.now() - fresh.at) / 1000)}s ago): demo ${demoRun ? 'RUNNING' : 'STOPPED'}, autoscale ${autoscale ? 'ON' : 'OFF'}, ${chatsSent} chats sent`);
  if (process.env.SCOPE_START_STOPPED === '1') console.log('[scope] SCOPE_START_STOPPED=1: demo starts STOPPED — press START when ready');
  saveState();
  if (!LIVE) return;
  const ctx = await run(['config', 'current-context']);
  if (!KUBE_CONTEXT) console.warn(`[scope] KUBE_CONTEXT not set — using current context ${ctx.out?.trim()}`);
  await Promise.all([refreshKube(), refreshBooking()]);
  if (!kagentApi) {
    await new Promise(resolve => {
      forward('svc/kagent-controller', 8083, port => {
        const first = !kagentApi, was = kagentApi;
        kagentApi = `http://127.0.0.1:${port}`;
        if (first || was !== kagentApi) console.log(`controller → ${kagentApi} (kubectl port-forward svc/kagent-controller)`);
        if (first) resolve(); else detect();
      }, API_PORT);
      setTimeout(resolve, 8000);
    });
    let uiUrl = '';
    forward('svc/kagent-ui', 8080, port => {
      const u = `http://localhost:${port}`;
      if (u !== uiUrl) console.log(`kagent UI → ${u}  (chat with agents to light up the board)${uiUrl ? ' — MOVED, reopen the UI tab' : ''}`);
      uiUrl = u; versions.ui = u; send({ type: 'versions', ...versions });
    }, UI_PORT);
  }
  if (!kagentApi) setHealth('error', 'could not port-forward svc/kagent-controller (is kagent installed in this context?)');
  await detect();
  send({ type: 'mode', live: LIVE, source: mode });
  send({ type: 'versions', ...versions });
  every(800, poll);              // fast enough to catch short LLM turns on a worker
  every(10_000, refreshKube);
  every(60_000, refreshBooking);
  every(2000, scrapeRouter);
  every(1000, computeQueue);
  setInterval(() => send({ type: 'hb', t: Date.now() }), 1000);   // the board's "still connected" signal
  setTimeout(() => every(3000, sampleMetrics), 3000);
  setTimeout(() => every(15_000, () => send({ type: 'telemetry_basis', ...telemetryBasis() })), 4000);
  setTimeout(() => every(3000, pollSessions), 3000);
});
