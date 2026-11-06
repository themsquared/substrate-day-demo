#!/usr/bin/env node
// Auto-stimulator: sends REAL chats to random agents so the live board keeps
// moving during a POC. Nothing is faked — every prompt creates a Session,
// restores a real actor from its snapshot, runs a real LLM turn, and
// checkpoints back. kagent 1.0: A2A 1.0 SendMessage on POST /agents/{ns}/{name}.
// One chat = one Session: the Session is created up front and a pool-full
// retry goes back INTO it (lib/kagent.mjs converse), never into a new one.
//
//   node stimulate.mjs --budget 20               # ALWAYS set a budget on a paid model
//   node stimulate.mjs --concurrency 3 --interval 4 --budget 30
//   node stimulate.mjs --pool all --budget 10    # include every pool's agents
//   node stimulate.mjs --budget 60 --oversub 0   # on stage: never park TALK TO IT
//   node stimulate.mjs --budget 40 --hog capacity-planner   # a noisy neighbor (Fairness tab)
//
// --budget N stops THIS generator after N chats; add --halt-demo to also flip
// the board's STOP DEMO switch when it is reached. While the presenter's own
// TALK TO IT chat is in flight (Scope /demo says "yield"), no new chats are
// dispatched. If Scope's controller port-forward moves (pod or Scope restart)
// the new address is picked up from Scope, and a turn whose connection died
// mid-flight is looked up by messageId instead of being reported as failed.
//
// With server.mjs --live running, the controller address, the agent list and
// the pool size come from Scope (http://127.0.0.1:8123/agents) and the board
// shows this generator's retry queue. Standalone: KAGENT_API=http://127.0.0.1:8083
// (your own port-forward) and kubectl for the agent list.
import { execFileSync } from 'node:child_process';
import { kagent } from './lib/kagent.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const VIZ = process.env.VIZ || `http://127.0.0.1:${process.env.PORT || 8123}`;
const INTERVAL = Number(arg('interval', 2));   // mean seconds between dispatch checks
const LOAD = Number(arg('load', 0.5));         // fraction of long-form prompts
const CONC_ARG = Number(arg('concurrency', 0));
const OVERSUB = Number(arg('oversub', 3));     // in flight beyond the pool's slots
const BUDGET = Number(arg('budget', 0));       // stop after N chats (0 = unlimited)
const POOL = arg('pool', '');                  // default: Scope's default pool
const HALT_DEMO = process.argv.includes('--halt-demo');   // budget reached → STOP DEMO for everyone
const HOG = arg('hog', '');                    // one agent that takes --hog-share of dispatches
const HOG_SHARE = Number(arg('hog-share', 0.6));
const KUBE_CONTEXT = process.env.KUBE_CONTEXT || '';
const KAGENT_USER = process.env.KAGENT_USER || 'admin@kagent.dev';
// A2A messageIds start with "stim-" so Scope's session ingest knows these
// turns are ours (the board already shows them through /activity).
// Pool-full (kagent 1.0: JSON-RPC -32004 KAGENT_SEND_NOT_ACCEPTED after the
// router's parking budget runs out — 5s on the rc2 chart, 60s on the 1.0.0
// chart) is recognised by lib/kagent.mjs.

const QUICK_PROMPTS = [
  'In one short sentence, what is your job?',
  'Give me one tip from your specialty. One sentence.',
  'What would you check first during an incident? One sentence.',
  'Reply with a haiku about Kubernetes.',
  'One sentence: why do snapshots beat idle pods?',
];
// Longer generations hold an actor on its worker for several seconds — that's
// what makes several bays glow at once instead of a single 1s flash.
const LONG_PROMPTS = [
  'Write a 10-step runbook for a failed rollout, one sentence per step.',
  'Draft a ~200-word incident postmortem for a fictional cache outage.',
  'Explain in ~200 words how you would triage rising p99 latency.',
  'List 12 things to check after a Kubernetes upgrade, one line each.',
  'Write a ~200-word briefing on why idle agents waste cluster capacity.',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = a => a[Math.floor(Math.random() * a.length)];
const jitter = s => (s * (0.5 + Math.random())) * 1000;

async function fromScope() {
  try {
    const q = POOL ? `?pool=${encodeURIComponent(POOL)}` : '';
    const r = await fetch(`${VIZ}/agents${q}`, { signal: AbortSignal.timeout(3000) });
    return await r.json();
  } catch { return null; }
}
let scope = await fromScope();
let API = process.env.KAGENT_API || scope?.api;
if (!API) { console.error('no controller: start `node server.mjs --live` or set KAGENT_API'); process.exit(1); }
// messageIds carry the Scope instance we report to, so that Scope skips them
// in session ingest (it already shows them through /activity) while another
// Scope still shows them
const INST = scope?.instance || 'solo';
// Scope's controller port-forward can move (controller pod restart, Scope
// restart): re-read the address from Scope after a connection error
let refreshing = null;
async function refreshApi() {
  if (process.env.KAGENT_API) return false;
  refreshing ??= (async () => {
    const s = await fromScope();
    refreshing = null;
    if (s?.api && s.api !== API) { console.log(`controller moved: ${API} → ${s.api}`); API = s.api; return true; }
    return false;
  })();
  return refreshing;
}
// the same adapter Scope uses; the controller address follows refreshApi()
const kg = kagent({ apiBase: () => API, user: KAGENT_USER });

function kubectlAgents() {
  const sel = POOL && POOL !== 'all' ? [] : ['-l', 'scope.demo/pool=default'];
  const out = execFileSync('kubectl', [...(KUBE_CONTEXT ? ['--context', KUBE_CONTEXT] : []),
    'get', 'agents.api.kagent.dev', '-A', ...sel, '-o', 'json'], { encoding: 'utf8' });
  return JSON.parse(out).items
    .filter(a => (a.status?.conditions ?? []).some(c => c.type === 'Ready' && c.status === 'True'))
    .map(a => `${a.metadata.namespace}/${a.metadata.name}`);
}
const agents = scope?.agents?.length ? scope.agents.map(a => `${a.ns}/${a.name}`) : kubectlAgents();
if (!agents.length) { console.error('no Ready agents found'); process.exit(1); }
const hogRef = HOG ? agents.find(a => a.endsWith(`/${HOG}`)) : null;
if (HOG && !hogRef) { console.error(`--hog ${HOG}: not one of the Ready agents`); process.exit(1); }
const pick = () => hogRef && Math.random() < HOG_SHARE ? hogRef : rand(agents);

let inFlight = 0, sent = 0, ok = 0, failed = 0;
const slots = async () => (await fromScope())?.slots || 2;

// chats in flight, one entry per CHAT ({id, name, ns, since, phase}), so the
// board can show two parked chats of one agent as two
const flying = new Map();      // id -> { id, name, ns, since, phase: 'sent'|'retry' }
let queueTimer = null;
function reportQueue() {
  clearTimeout(queueTimer);
  queueTimer = setTimeout(() => {
    fetch(`${VIZ}/queue`, { method: 'POST', body: JSON.stringify({ inflight: [...flying.values()] }),
      signal: AbortSignal.timeout(3000) }).catch(() => {});
  }, 150);
}
setInterval(reportQueue, 5000).unref();   // keep the board's view of us fresh
function reportActivity(ev) {
  fetch(`${VIZ}/activity`, { method: 'POST', body: JSON.stringify(ev),
    signal: AbortSignal.timeout(2000) }).catch(() => {});
}

async function a2a(ns, name, method, params, timeout) {
  const r = await fetch(`${API}/agents/${ns}/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', 'X-User-Id': KAGENT_USER },
    body: JSON.stringify({ jsonrpc: '2.0', id: `stim-${INST}-q`, method, params }), signal: AbortSignal.timeout(timeout) });
  return r.json();
}
// the task a messageId started, once it is terminal (null: not found / not yet)
async function lookUp(ns, name, messageId, after) {
  const j = await a2a(ns, name, 'ListTasks', { pageSize: 100, includeArtifacts: true, historyLength: 10, statusTimestampAfter: after }, 6000);
  const t = (j.result?.tasks ?? []).find(t => (t.history ?? []).some(m => m.role === 'ROLE_USER' && m.messageId === messageId));
  return t && /COMPLETED|FAILED|CANCELED|REJECTED|INPUT_REQUIRED|AUTH_REQUIRED/.test(t.status?.state ?? '') ? t : t ? 'open' : null;
}
// a connection error mid-send: pick up a moved controller, then find out
// whether the turn ran anyway (it usually did) before calling it a failure
async function recover(ns, name, messageId, t0, err) {
  const after = new Date(t0 - 5000).toISOString();
  for (let i = 0; i < 30 && !stop; i++) {
    await sleep(2000);
    await refreshApi();
    let t;
    try { t = await lookUp(ns, name, messageId, after); } catch { continue; }   // still reconnecting
    if (t === 'open') continue;
    if (!t) { if (i >= 5) break; continue; }       // never reached the agent
    const text_ = (t.artifacts ?? []).flatMap(a => a.parts ?? []).map(p => p.text ?? '').join('')
               || (t.status?.message?.parts ?? []).map(p => p.text ?? '').join('');
    return /FAILED|REJECTED|CANCELED/.test(t.status.state) ? { error: `${t.status.state}: ${text_}`, recovered: true }
                                                            : { text: text_, recovered: true };
  }
  return { error: `connection lost: ${err}`, lost: true };
}

async function chat(agentRef) {
  const [ns, name] = agentRef.split('/');
  const prompt = Math.random() < LOAD || agentRef === hogRef ? rand(LONG_PROMPTS) : rand(QUICK_PROMPTS);
  const id = `stim-${INST}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const f = { id, name, ns, since: Date.now(), phase: 'sent' };
  inFlight++; sent++;
  flying.set(id, f); reportQueue();
  const t0 = Date.now();
  let lostTries = 0, prompted = false;
  // the prompt belongs to its session (known before the first send, unless
  // CreateSession is unavailable)
  const prompt_ = ctx => { if (prompted) return; prompted = true;
    reportActivity({ agent: name, kind: 'prompt', text: prompt, via: 'stimulator', contextId: ctx }); };
  try {
    const r = await kg.converse(ns, name, prompt, {
      id, sessionName: 'Scope · stimulator',
      onSession: ctx => { f.contextId = ctx; reportQueue(); prompt_(ctx); },
      onAttempt: () => { prompt_(undefined); f.phase = 'sent'; f.since = Date.now(); },
      onRetry: (res) => {
        if (f.phase !== 'retry') console.log(`… ${name}: ${res.busy ? 'session busy' : 'pool full (router parked it, gave up; send not accepted)'} — retrying in the same session`);
        f.phase = 'retry'; reportQueue();
      },
      // a connection error mid-send: pick up a moved controller, then find
      // out whether the turn ran anyway (it usually did) before calling it a
      // failure; one that never arrived is resent into the same session
      recover: async (res, messageId) => {
        console.log(`… ${name}: connection lost (${res.error}) — checking whether the turn ran`);
        await refreshApi();
        const x = await recover(ns, name, messageId, t0, res.error);
        if (x.lost) return { ok: false, poolFull: ++lostTries < 3, error: x.error };
        return x.error ? { ok: false, recovered: true, error: x.error } : { ok: true, recovered: true, text: x.text };
      },
      stop: () => stop || !demoRun,
    });
    const ms = Date.now() - t0, secs = (ms / 1000).toFixed(1);
    const tag = (r.recovered ? ' (recovered after a lost connection)' : '') + (r.tries > 1 ? ` (${r.tries} tries, one session)` : '');
    if (!r.ok) { failed++; console.log(`✗ ${name} (${secs}s): ${String(r.error).slice(0, 100)}${tag}`);
      reportActivity({ agent: name, kind: 'error', text: String(r.error).slice(0, 300), ms, via: 'stimulator', contextId: r.contextId }); }
    else { ok++; console.log(`✓ ${name} (${secs}s)${tag}: ${(r.text || '(no text)').slice(0, 90).replace(/\n/g, ' ')}`);
      reportActivity({ agent: name, kind: 'reply', text: (r.text || '(no text)').slice(0, 600), ms, via: 'stimulator', contextId: r.contextId }); }
  } catch (e) {
    failed++; console.log(`✗ ${name}: ${String(e.message).slice(0, 90)}`);
    reportActivity({ agent: name, kind: 'error', text: String(e.message).slice(0, 200), via: 'stimulator' });
  } finally {
    flying.delete(id); reportQueue();
    inFlight--;
  }
}

let concurrency = CONC_ARG || (await slots()) + OVERSUB;
console.log(`stimulating ${agents.length} agents via ${API} — ≤${concurrency} in flight`
  + `${CONC_ARG ? '' : ` (auto: pool slots + ${OVERSUB}; re-checks as you scale)`}, ${Math.round(LOAD * 100)}% long-form`
  + (hogRef ? `, hog ${HOG} gets ${Math.round(HOG_SHARE * 100)}% of chats (long-form)` : '')
  + (BUDGET ? `, budget ${BUDGET} chats${HALT_DEMO ? ' then STOP DEMO' : ''}` : ', NO BUDGET (Ctrl-C or STOP DEMO to halt)'));
console.log(agents.map(a => '  ' + a).join('\n'));

let stop = false;
process.on('SIGINT', () => { stop = true; console.log(`\nstopping… sent=${sent} ok=${ok} failed=${failed}`); });

// the board's STOP DEMO button is the master switch for billable chats.
// Polled on its own 500ms timer, so a stop reaches us within ~0.5s even while
// the dispatch loop sleeps; `yield` holds new chats while the presenter talks.
let demoRun = true, yieldNow = false, checking = false;
async function checkDemo() {
  if (checking) return;          // one poll at a time: answers must not arrive out of order
  checking = true;
  try {
    const j = await (await fetch(`${VIZ}/demo`, { signal: AbortSignal.timeout(1500) })).json();
    if (demoRun !== j.run) console.log(j.run ? '▶ demo resumed' : '■ demo stopped — no new chats');
    if (!!j.yield !== yieldNow) console.log(j.yield ? '⏸ presenter is talking to an agent — holding new chats' : '▶ presenter done — dispatching again');
    demoRun = j.run; yieldNow = !!j.yield;
  } catch {}   // board absent → keep running standalone
  finally { checking = false; }
}
await checkDemo();
setInterval(checkDemo, 500).unref();

let lastSize = Date.now();
while (!stop) {
  if (BUDGET && sent >= BUDGET) {
    console.log(`■ budget reached: ${sent}/${BUDGET} chats dispatched — stopping this generator`
      + (HALT_DEMO ? ' and flipping STOP DEMO' : ' (the demo keeps RUNNING; --halt-demo would stop it)'));
    if (HALT_DEMO) fetch(`${VIZ}/demo`, { method: 'POST', body: JSON.stringify({ run: false }),
      signal: AbortSignal.timeout(2000) }).catch(() => {});
    break;
  }
  if (!CONC_ARG && Date.now() - lastSize > 10_000) {   // follow live pool scaling
    lastSize = Date.now();
    slots().then(n => { const c = n + OVERSUB; if (c !== concurrency) {
      console.log(`pool now has ${n} slots — concurrency → ${c}`); concurrency = c; } });
  }
  while (demoRun && !yieldNow && inFlight < concurrency && !stop && !(BUDGET && sent >= BUDGET)) {
    chat(pick()); await sleep(400);
  }
  await sleep(jitter(INTERVAL));
}
while (inFlight > 0) await sleep(500);
process.exit(0);
