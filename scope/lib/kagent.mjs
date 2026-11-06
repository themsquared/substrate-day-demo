// kagent 1.0 adapter: everything Scope reads from (and sends to) the kagent
// controller on :8083. Written against kagent 1.0.0-rc2 + Substrate 1.0.0-rc2
// and checked against kagent 1.0.0-rc3 + Substrate 1.0.0 (2026-11-06): every
// surface Scope uses is byte-identical in rc3 (grpcweb.go, system.go,
// a2agateway/http.go, a2a_version.go). The one schema change rc2 -> rc3 is
// DeleteSessionRequest.force (bool, field 2), which lib/schema.json carries
// and rc2 ignores. See README "Version pins" for what was run live.
//
// What changed from kagent 0.10 (and why the board went blank):
//   * The controller has no REST /api/* any more. /api/substrate/status now
//     answers an EMPTY 200 from a catch-all. The inventory is gRPC-Web:
//     kagent.api.v1.SystemService/{GetSubstrateSummary,ListSubstrateActors,
//     ListSubstrateWorkers}, paged at <=100. The /api/ prefix is stripped by
//     the controller's gRPC-Web handler, so methods live at /api/<svc>/<rpc>.
//   * Actors are raw substrate.ateapi.v1.Actor records. Workers no longer
//     name the actor they host: the join is actor.status.worker_assignment.
//   * A worker is no longer one sandbox: it hosts as many actors as its
//     capacity (pod limits) fits, each booked at its runtime LIMITS
//     (controller config runtimeDefaults, cpu 1 / memory 1Gi by default).
//     Scope draws each worker as that many slots.
//   * Chat is A2A 1.0 JSON-RPC: POST /agents/{ns}/{name}, method SendMessage,
//     header A2A-Version: 1.0. No contextId = a new Session (and a new actor).
import { client, GrpcError } from './grpcweb.mjs';

const SYS = 'kagent.api.v1.SystemService/';
const SESS = 'kagent.api.v1.SessionService/';

// ateapi ActorState -> the board's vocabulary
export const STATE = {
  ACTOR_STATE_RESUMING: 'Resuming', ACTOR_STATE_RUNNING: 'Running',
  ACTOR_STATE_SUSPENDING: 'Suspending', ACTOR_STATE_SUSPENDED: 'Suspended',
  ACTOR_STATE_CRASHED: 'Crashed', ACTOR_STATE_DELETING: 'Deleting',
  ACTOR_STATE_REVERTING: 'Reverting', ACTOR_STATE_UNSPECIFIED: 'Unknown',
};
export const ON_WORKER = new Set(['Resuming', 'Running', 'Suspending', 'Reverting']);

// Generated ActorTemplate names: "<agent<=50>-<12 hex>" on kagent 1.0,
// "<agent>-<16 hex>" on kagent 0.10. Strip either so chips, chat and session
// ingest all speak the agent's own name.
export const deSuffix = n => typeof n === 'string' ? n.replace(/-(?:[0-9a-f]{16}|[0-9a-f]{12})$/, '') : n;

// Messages Scope (and stimulate.mjs, preflight.sh) send carry one of these
// messageId prefixes, so session ingest can tell them from kagent-UI chats.
// Scope and stimulate add an instance tag ("scope-<inst>-…", "stim-<inst>-…")
// so a Scope skips only ITS OWN turns and still shows another Scope's.
export const OWN_MESSAGE = /^(scope|stim|surge|preflight|probe)-/;
export const ownMessage = inst => new RegExp(`^(scope|stim|surge)-${inst}-`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Where an ingested turn came from, judged by its user messageId (and the
// doorbell's "[telegram …]" tag). The kagent UI and CLI both use random
// UUIDs; anything else is a raw A2A client (curl, scripts, other tools).
export function sourceOf(messageId = '', text = '') {
  if (/^\[telegram/.test(text)) return 'telegram';
  if (/^(scope|surge)-/.test(messageId)) return 'other scope';
  if (/^stim-/.test(messageId)) return 'other stimulator';
  if (/^(preflight|probe)-/.test(messageId)) return 'preflight';
  if (UUID.test(messageId)) return 'kagent-ui/cli';
  return 'a2a';
}

// Why a send did not reach an agent because the pool had no room. Substrate
// 1.0 parks the request in atenet-router for the chart's parking budget
// (atenetRouter.requestParking.budget: 5s on the rc2 chart, 60s on the 1.0.0
// chart; kagent's installer sets neither) and then fails it
// (router outcome resume_error; scheduler outcome no_capacity). Through the
// kagent A2A gateway that surfaces as JSON-RPC -32004 "input was not
// accepted; retry after the session becomes available" with reason
// KAGENT_SEND_NOT_ACCEPTED (verified on rc2; the gateway code is unchanged
// in rc3); a direct router call says
// "503 actor <id> unavailable: no worker has room for the actor".
export const POOL_FULL = /KAGENT_SEND_NOT_ACCEPTED|input was not accepted|retry after the session|no worker has room|router at capacity|resource.?exhausted|no free workers|worker is full/i;
// The Session exists but is mid lifecycle operation (a restore the router just
// gave up on is still unwinding): same -32004, no KAGENT_SEND_NOT_ACCEPTED
// reason. Also safe to retry into the same Session after a backoff.
export const SESSION_BUSY = /cannot accept work during a lifecycle operation/i;

const textOf = parts => (parts ?? []).map(p => p.text ?? '').join('');
export function replyOf(task) {
  const art = (task?.artifacts ?? []).map(a => textOf(a.parts)).filter(Boolean).join('\n');
  return art || textOf(task?.status?.message?.parts);
}

// "1" -> 1000, "500m" -> 500 ; "1Gi" -> bytes
export const cpuMillis = s => !s ? 0 : String(s).endsWith('m') ? parseInt(s) : Math.round(parseFloat(s) * 1000);
export function bytesOf(s) {
  if (!s) return 0;
  const m = String(s).match(/^([\d.]+)\s*([KMGTP]i?)?$/);
  if (!m) return 0;
  const mult = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2]] ?? 1;
  return Math.round(parseFloat(m[1]) * mult);
}

export function kagent({ apiBase, user = 'admin@kagent.dev', atespace = '' }) {
  // apiBase is a function so a respawned port-forward can move it
  const base = () => (typeof apiBase === 'function' ? apiBase() : apiBase);
  const grpc = () => client(`${base()}/api`, async () => ({ 'X-User-Id': user }));
  const unary = (m, req, opts) => grpc().unary(m, req, opts);

  async function listAll(method, req, key, maxPages = 50) {
    const out = []; let token = '', resp = {};
    for (let i = 0; i < maxPages; i++) {
      resp = await unary(method, { ...req, page: { limit: 100, page_token: token } }, { timeout: 5000 });
      out.push(...(resp[key] ?? []));
      token = resp.page?.next_page_token;
      if (!token) break;
    }
    return { ...resp, [key]: out };
  }

  const version = () => unary(SYS + 'GetVersion', {}, { timeout: 4000 });

  // ── inventory ──────────────────────────────────────────────────────────────
  // The summary walks every ate-api page server side; poll it slower than the
  // actor/worker lists.
  let summary = { at: 0, v: null };
  async function inventory() {
    const [w, a] = await Promise.all([
      listAll(SYS + 'ListSubstrateWorkers', {}, 'workers'),
      listAll(SYS + 'ListSubstrateActors', atespace ? { atespace } : {}, 'actors'),
    ]);
    if (!summary.v || Date.now() - summary.at > 4000)
      summary = { at: Date.now(), v: await unary(SYS + 'GetSubstrateSummary', atespace ? { atespace } : {}, { timeout: 8000 }) };
    return { workers: w.workers ?? [], actors: a.actors ?? [], summary: summary.v,
             ateApiError: summary.v?.ate_api_error || a.ate_api_error || w.ate_api_error || '' };
  }

  // ── chat: one A2A SendMessage ──────────────────────────────────────────────
  // Returns { ok, poolFull, state, text, taskId, contextId, http, error, ms }.
  async function send(ns, name, text, { messageId, contextId, timeout = 180_000, signal } = {}) {
    const t0 = Date.now();
    const message = { messageId, role: 'ROLE_USER', parts: [{ text }], ...(contextId && { contextId }) };
    let r, body = '';
    try {
      r = await fetch(`${base()}/agents/${ns}/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', 'X-User-Id': user },
        body: JSON.stringify({ jsonrpc: '2.0', id: messageId, method: 'SendMessage', params: { message } }),
        signal: signal && AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : signal ?? AbortSignal.timeout(timeout),
      });
      body = await r.text();
    } catch (e) {
      // network: the request never got an answer (port-forward dropped,
      // controller restarted, or we aborted it). The turn may still run.
      return { ok: false, network: true, aborted: !!signal?.aborted,
               error: String(e.cause?.code ?? e.message ?? e).slice(0, 300), ms: Date.now() - t0 };
    }
    const ms = Date.now() - t0;
    let j = null;
    try { j = JSON.parse(body); } catch {}
    if (!r.ok || !j) {
      const err = (j?.error?.message ?? body ?? '').slice(0, 300) || `HTTP ${r.status}`;
      return { ok: false, http: r.status, poolFull: r.status === 503 || r.status === 429 || POOL_FULL.test(err),
               error: `HTTP ${r.status}: ${err}`, ms };
    }
    if (j.error) {
      const err = `${j.error.code ?? ''} ${j.error.message ?? ''}`.trim();
      const all = err + ' ' + JSON.stringify(j.error.data ?? '');
      const busy = SESSION_BUSY.test(all);
      return { ok: false, http: r.status, poolFull: busy || POOL_FULL.test(all) || /unavailable/i.test(err), busy, error: err.slice(0, 300), ms };
    }
    const task = j.result?.task;
    if (!task) {   // a bare Message reply
      const m = j.result?.message;
      return { ok: true, state: 'MESSAGE', text: textOf(m?.parts), contextId: m?.contextId, ms };
    }
    const state = task.status?.state ?? '';
    const reply = replyOf(task);
    const failed = /FAILED|REJECTED|CANCELED/.test(state);
    return { ok: !failed, state, text: reply, taskId: task.id, contextId: task.contextId, http: r.status,
             poolFull: failed && POOL_FULL.test(reply), error: failed ? (reply || state) : undefined, ms };
  }

  // A2A ListTasks for one agent, newest status after `after` (RFC3339).
  async function listTasks(ns, name, { after, contextId, pageSize = 50 } = {}) {
    const params = { pageSize, includeArtifacts: true, historyLength: 10,
                     ...(after && { statusTimestampAfter: after }), ...(contextId && { contextId }) };
    const r = await fetch(`${base()}/agents/${ns}/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', 'X-User-Id': user },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'scope-list', method: 'ListTasks', params }),
      signal: AbortSignal.timeout(6000),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result?.tasks ?? [];
  }

  // SessionService/ListSessions (gRPC-Web), every creator. The server pages
  // in ascending id order (UUIDv7 = oldest first) and has no order option, so
  // the NEWEST sessions are on the last page: walk every page (≈5 ms per 100)
  // and say so when the cap cuts the tail off.
  async function sessions(maxPages = 200) {
    const out = []; let token = '';
    for (let i = 0; i < maxPages; i++) {
      const resp = await unary(SESS + 'ListSessions', { all_creators: true, page: { limit: 100, page_token: token } }, { timeout: 5000 });
      out.push(...(resp.sessions ?? []));
      token = resp.page?.next_page_token;
      if (!token) return { sessions: out, truncated: false };
    }
    return { sessions: out, truncated: true };
  }

  // The task (if any) that a given user messageId started, for an agent.
  // Used to recover the reply of a turn whose HTTP request died in flight.
  async function findTask(ns, name, messageId, { after } = {}) {
    const tasks = await listTasks(ns, name, { after, pageSize: 100 });
    return tasks.find(t => (t.history ?? []).some(m => m.role === 'ROLE_USER' && m.messageId === messageId)) ?? null;
  }

  // SessionService/CreateSession. request_id makes it idempotent per creator
  // (the same id returns the same Session), so a chat that is retried — or a
  // Scope that crashes and resends — never makes a second Session.
  async function createSession(ns, name, { requestId, sessionName = '' } = {}) {
    const r = await unary(SESS + 'CreateSession', { request_id: requestId, name: sessionName,
                                                   agent: { namespace: ns, name } }, { timeout: 8000 });
    const s = r.session ?? {};
    const contextId = s.context_id || s.id;
    if (!contextId) throw new Error('CreateSession returned no session id');
    return { contextId, session: s };
  }

  // SessionService/DeleteSession. `force` (kagent 1.0.0-rc3+) ends an active
  // turn instead of refusing the delete; rc2 ignores the field and refuses
  // while a turn runs. For cleanup tooling; the board never deletes.
  async function deleteSession(id, { force = false } = {}) {
    return unary(SESS + 'DeleteSession', { session_id: id, ...(force && { force: true }) }, { timeout: 15_000 });
  }

  // ONE logical chat = ONE Session, however many times it is retried.
  //
  // kagent 1.0 creates a Session for every SendMessage that has no contextId,
  // BEFORE it tries to reach the actor. A pool-full send (-32004 "input was
  // not accepted; retry after the session becomes available",
  // KAGENT_SEND_NOT_ACCEPTED) therefore already HAS a Session: resending it
  // as a fresh message (new messageId, no contextId) leaves that Session
  // behind and makes another one — 27 chats once made 62 Sessions. So:
  //   1. create the Session up front (CreateSession, request_id = chat id),
  //      and send every attempt with its contextId — the retry lands in the
  //      same Session, and the board knows the session before the first reply;
  //   2. if CreateSession is unavailable, send without contextId but with the
  //      SAME messageId on every attempt: kagent derives the Session's
  //      request id from (agent, messageId), so it hands back the same one.
  // Hooks: onSession(contextId, created), onAttempt(n), onRetry(result, n),
  // recover(result, messageId) for a send whose connection died,
  // stop() -> true to give up between attempts.
  async function converse(ns, name, text, { id, contextId, sessionName, signal, maxTries = 40,
                                            onSession, onAttempt, onRetry, recover, stop,
                                            backoff = () => 1500 + Math.random() * 1500 } = {}) {
    let created = false, sessionError;
    if (!contextId) {
      try { ({ contextId } = await createSession(ns, name, { requestId: id, sessionName })); created = true; }
      catch (e) { sessionError = String(e.message ?? e).slice(0, 200); }
    }
    if (contextId) onSession?.(contextId, created);
    let result, tries = 0;
    for (;;) {
      tries++;
      onAttempt?.(tries);
      // with a contextId each attempt gets its own messageId (recover() looks
      // a lost turn up by it); without one the messageId IS the session key
      const messageId = contextId ? `${id}-${tries}` : id;
      result = await send(ns, name, text, { messageId, contextId, signal });
      if (result.network && !result.aborted && recover) result = await recover(result, messageId);
      if (!contextId && result.contextId) { contextId = result.contextId; onSession?.(contextId, false); }
      if (!result.poolFull || tries >= maxTries || stop?.()) break;
      onRetry?.(result, tries);
      await new Promise(r => setTimeout(r, backoff(tries)));
      if (stop?.()) { result = { ...result, stopped: true }; break; }
    }
    return { ...result, contextId: result.contextId ?? contextId, tries, created, sessionError };
  }

  // One Session's conversation, read back from kagent: its turns as the
  // board's activity entries (oldest first) — for a session chip whose
  // drawer opens on a conversation this Scope did not see live.
  async function sessionHistory(ns, name, contextId, { limit = 40 } = {}) {
    const tasks = await listTasks(ns, name, { contextId, pageSize: Math.min(100, limit) });
    const items = [];
    for (const t of tasks) {
      const created = Date.parse(t.metadata?.['kagent.dev/a2a/task-created-at'] ?? '') || Date.parse(t.status?.timestamp ?? '') || 0;
      const um = (t.history ?? []).find(m => m.role === 'ROLE_USER' && (!m.taskId || m.taskId === t.id));
      const rawText = textOf(um?.parts);
      const via = sourceOf(um?.messageId, rawText);
      if (rawText) items.push({ t: created, kind: 'prompt', agent: name, contextId, via, history: true, messageId: um?.messageId,
        text: rawText.replace(/^\[telegram chat_id=\S+ from=([^\]]*)\]\s*/, '📱 $1: ').slice(0, 400) });
      const st = t.status?.state ?? '';
      if (/COMPLETED|FAILED|CANCELED|REJECTED|INPUT_REQUIRED|AUTH_REQUIRED/.test(st)) {
        const end = Date.parse(t.status?.timestamp ?? '') || created;
        const sent = (t.artifacts ?? []).flatMap(a => a.parts ?? [])
          .filter(p => /send_message$/.test(p.data?.name ?? '') && p.data?.args?.text).map(p => p.data.args.text);
        items.push({ t: end, kind: /FAILED|CANCELED|REJECTED/.test(st) ? 'error' : 'reply', agent: name, contextId, via, history: true,
          ms: created && end ? end - created : undefined,
          text: ((sent.length ? '📱 sent: ' + sent.join('\n') : '') || replyOf(t) || st).slice(0, 600) });
      }
    }
    return items.sort((a, b) => a.t - b.t);
  }

  return { version, inventory, send, listTasks, findTask, sessions, createSession, deleteSession, converse,
           sessionHistory, base, unary, GrpcError };
}
