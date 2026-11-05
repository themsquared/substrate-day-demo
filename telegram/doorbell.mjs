#!/usr/bin/env node
// The doorbell: the one always-on piece of the Telegram demo, and deliberately
// dumb. Telegram POSTs each message sent to the bot here (through the
// Cloudflare tunnel); the doorbell hands it to the agent over kagent's A2A
// JSON-RPC endpoint and is done. Substrate restores the agent, the agent
// answers on Telegram with its own bot (telegram/mcp.mjs), and the agent
// suspends again.
//
// It holds no bot token and no model key, and it never replies to Telegram
// itself. What it does hold:
//   - TELEGRAM_WEBHOOK_SECRET: Telegram echoes it on every delivery, so a
//     request without it (anyone else who finds the public URL) is refused.
//   - TELEGRAM_ALLOWED_CHATS: only these chats reach the agent. A message
//     from any other chat is logged with its chat id, for the allowlist.
//
// kagent 1.0.0-rc2 A2A: POST /agents/{ns}/{name}, JSON-RPC method SendMessage,
// header A2A-Version: 1.0. No contextId creates a new Session (a Substrate
// actor); its id comes back as result.task.contextId and continues it. One
// Session per Telegram chat, so the conversation, and the agent's memory of
// it, survive between messages as a snapshot. "/new" starts a fresh one. The
// chat -> contextId map is in memory: a doorbell restart starts new Sessions.
//
// The doorbell cannot answer the person itself, so it checks the agent did:
// a COMPLETED task with no send_message call gets one follow-up turn on the
// same Session, and any turn that still did not deliver is logged as
// {"event":"undelivered"} (grep for it during rehearsals).
//
// :8080 is the webhook (the only port the tunnel reaches). :8081 is admin,
// bound to 127.0.0.1 (kubectl exec only): POST /register asks the agent to
// register its webhook. Zero dependencies.
import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';

const env = process.env;
const NS = env.AGENT_NAMESPACE || 'kagent';
const AGENT = env.TELEGRAM_AGENT || 'sre-oncall';
const A2A_URL = `${(env.KAGENT_A2A || 'http://kagent-controller.kagent.svc.cluster.local:8083').replace(/\/$/, '')}/agents/${NS}/${AGENT}`;
const USER = env.KAGENT_USER || '';            // controller auth is "insecure" in the OSS install: X-User-Id names the caller
const PUBLIC_URL = (env.PUBLIC_URL || '').replace(/\/$/, '');
const SECRET = env.TELEGRAM_WEBHOOK_SECRET || '';
const ALLOWED = new Set((env.TELEGRAM_ALLOWED_CHATS || '').split(',').map(s => s.trim()).filter(Boolean));
const TURN_TIMEOUT_MS = Number(env.TURN_TIMEOUT_MS || 240_000);
const WEBHOOK_PORT = Number(env.WEBHOOK_PORT || 8080), ADMIN_PORT = Number(env.ADMIN_PORT || 8081);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = o => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
if (!SECRET) { console.error('TELEGRAM_WEBHOOK_SECRET is required'); process.exit(1); }
// PID 1 in the container: without this, a rollout waits out the 30s grace period
// while the old pod keeps serving with the old config.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));

class A2AError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
  get reason() {
    const d = [].concat(this.data ?? []);
    return d.map(x => x?.metadata?.reason ?? x?.reason).find(Boolean) ?? '';
  }
}

// One JSON-RPC call to the agent's public A2A endpoint.
async function rpc(method, params) {
  const r = await fetch(A2A_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', ...(USER && { 'X-User-Id': USER }) },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
  });
  const raw = await r.text();
  let j;
  try { j = JSON.parse(raw); } catch { throw new A2AError(r.status, `HTTP ${r.status}: ${raw.slice(0, 200) || '(empty body)'}`); }
  if (j.error) throw new A2AError(j.error.code, j.error.message, j.error.data);
  return j.result;
}

const texts = parts => (parts ?? []).map(p => p.text ?? '').join('');
// Tool calls come back in the task's artifacts as data parts, tagged
// kagent.dev/a2a/part-type: function_call {name, args} and function_response
// {name, response: {..., isError?, error?}}. Did the agent call send_message,
// and did telegram-mcp accept it?
function delivery(artifacts) {
  const parts = (artifacts ?? []).flatMap(a => a.parts ?? []);
  const kind = p => p?.metadata?.['kagent.dev/a2a/part-type'];
  const send = p => /(^|[^a-z])send_message$/i.test(p?.data?.name ?? '');
  const responses = parts.filter(p => kind(p) === 'function_response' && send(p)).map(p => p.data.response ?? {});
  return { called: parts.filter(p => kind(p) === 'function_call' && send(p)).length,
           ok: responses.some(r => !r.isError && !r.error),
           error: responses.map(r => r.error).find(Boolean) };
}
// result.task (usual) or result.message (a direct reply with no task)
function outcome(result) {
  const t = result?.task;
  if (t) return { state: t.status?.state ?? '', contextId: t.contextId, taskId: t.id, sent: delivery(t.artifacts),
                  reply: (t.artifacts ?? []).map(a => texts(a.parts)).join('') || texts(t.status?.message?.parts) };
  const m = result?.message;
  return { state: m ? 'MESSAGE' : '', contextId: m?.contextId, taskId: m?.taskId, sent: delivery([]), reply: texts(m?.parts) };
}

// fetch() throws TypeError('fetch failed'); the socket error is in e.cause
// (an AggregateError when both address families were tried).
const netCode = e => e instanceof TypeError ? (e.cause?.code ?? e.cause?.errors?.[0]?.code ?? '') : '';
const describe = e => `${e.message}${netCode(e) ? ` (${netCode(e)})` : ''}`;
// No connection was made, so the controller never saw the request (for
// example a controller pod restarting): safe to retry.
const NOT_CONNECTED = e => /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT)$/.test(netCode(e));
// The connection broke after the request went out: the turn may already be
// running, and a retry may run it twice. Retry once, never more.
const CUT_OFF = e => /^(ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED)$/.test(netCode(e));
// Retry what the gateway says was never dispatched (same messageId, so
// it is safe): KAGENT_SEND_NOT_ACCEPTED, and a full pool after the router's
// parking budget ("no worker has room"). A timeout is not retried.
const RETRYABLE = e => e instanceof A2AError &&
  (e.reason === 'KAGENT_SEND_NOT_ACCEPTED' || /no worker has room|unavailable|not accepted/i.test(e.message));
const STALE_CONTEXT = e => e instanceof A2AError && /not found|unknown (context|session)|deleted|deleting/i.test(e.message);

// One turn on a chat's Session (contextId undefined: a new Session).
async function turn(contextId, text) {
  const t0 = Date.now();
  const message = { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], ...(contextId && { contextId }) };
  for (let attempt = 0, cuts = 0, backoff = 500; ; attempt++) {
    try {
      const o = outcome(await rpc('SendMessage', { message }));
      return { ...o, ms: Date.now() - t0, attempts: attempt + 1 };
    } catch (e) {
      const cut = CUT_OFF(e) && ++cuts <= 1;
      if (!(RETRYABLE(e) || NOT_CONNECTED(e) || cut) || Date.now() - t0 > 90_000) throw e;
      log({ event: 'retry', attempt: attempt + 1, code: e.code ?? (netCode(e) || undefined), reason: e.reason || undefined,
            error: describe(e).slice(0, 160) });
      await sleep(backoff + Math.random() * backoff);
      backoff = Math.min(backoff * 2, 8000);
    }
  }
}

// chat -> contextId (the kagent Session id)
const contexts = new Map();
async function chatTurn(chat, text, { fresh }) {
  if (fresh) contexts.delete(chat);
  let ctx = contexts.get(chat);
  let r;
  try { r = await turn(ctx, text); }
  catch (e) {
    if (!ctx || !STALE_CONTEXT(e)) throw e;
    log({ event: 'session-gone', chat, contextId: ctx, error: e.message.slice(0, 160) });
    contexts.delete(chat); ctx = undefined;
    r = await turn(undefined, text);
  }
  if (r.contextId && r.contextId !== ctx) {
    contexts.set(chat, r.contextId);
    log({ event: 'session', chat, contextId: r.contextId, fresh: !!fresh });
  }
  return r;
}

// Messages from one chat run one at a time (a Session takes one task at once).
const queues = new Map();
function enqueue(chat, job) {
  // the person gets no answer: say so loudly
  const next = (queues.get(chat) ?? Promise.resolve()).then(job)
    .catch(e => log({ event: 'undelivered', chat, why: 'turn failed', code: e.code ?? (netCode(e) || undefined), error: describe(e) }));
  queues.set(chat, next);
}

const seenUpdates = new Set();
function onUpdate(u) {
  if (seenUpdates.has(u.update_id)) return;               // Telegram retries deliveries
  seenUpdates.add(u.update_id);
  if (seenUpdates.size > 1000) seenUpdates.delete(seenUpdates.values().next().value);
  const m = u.message;
  if (!m?.chat) return;
  const chat = String(m.chat.id);
  const who = [m.from?.first_name, m.from?.username && `@${m.from.username}`].filter(Boolean).join(' ') || 'unknown';
  if (!ALLOWED.has(chat)) {
    log({ event: 'ignored', chat_id: chat, from: who, hint: 'add this chat id to TELEGRAM_ALLOWED_CHATS to let it reach the agent' });
    return;
  }
  const body = m.text ?? m.caption ?? `(sent a ${Object.keys(m).find(k => ['photo', 'sticker', 'voice', 'video', 'document'].includes(k)) ?? 'message'} with no text; you can read text only)`;
  const fresh = /^\/(new|start)\b/.test(body);
  const text = fresh ? `[telegram chat_id=${chat} from=${who}] (They started a new conversation. Greet them in one line.)`
                     : `[telegram chat_id=${chat} from=${who}] ${body}`;
  log({ event: 'ring', chat, from: who, chars: body.length });
  enqueue(chat, async () => {
    let r = await chatTurn(chat, text, { fresh });
    const done = (event, r) => log({ event, chat, contextId: r.contextId, task: r.taskId, state: r.state, ms: r.ms,
                                     attempts: r.attempts, sent: r.sent.ok ? 'ok' : r.sent.called ? 'failed' : 'no', reply: r.reply.slice(0, 160) });
    done('done', r);
    // The agent answered without calling send_message: the phone shows
    // nothing. Ask once, on the same Session, to deliver that answer.
    if (r.state === 'TASK_STATE_COMPLETED' && !r.sent.called && r.contextId) {
      r = await turn(r.contextId, `[undelivered chat_id=${chat} from=${who}] Your last answer did not reach them: you did not call send_message. ` +
                                  `Call the telegram send_message tool now with chat_id=${chat} and that answer. Do not redo the work.`);
      done('nudged', r);
    }
    if (!r.sent.ok)
      log({ event: 'undelivered', chat, contextId: r.contextId, task: r.taskId, state: r.state,
            why: r.state !== 'TASK_STATE_COMPLETED' ? `task ${r.state || 'returned no state'}`
               : r.sent.called ? 'send_message failed' : 'the agent never called send_message',
            error: (r.sent.error || (r.state !== 'TASK_STATE_COMPLETED' ? r.reply : '') || '').slice(0, 200) || undefined });
  });
}

const secretOk = h => {
  const a = Buffer.from(String(h ?? '')), b = Buffer.from(SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
};
const readBody = req => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => resolve(b)); req.on('error', reject);
});

// :8080, public through the tunnel: the webhook and a health check, nothing else
createServer(async (req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (req.method !== 'POST' || req.url !== '/telegram') { res.writeHead(404); return res.end(); }
  if (!secretOk(req.headers['x-telegram-bot-api-secret-token'])) {
    log({ event: 'refused', why: 'bad or missing webhook secret' });
    res.writeHead(401); return res.end();
  }
  let u;
  try { u = JSON.parse(await readBody(req)); } catch { res.writeHead(400); return res.end(); }
  res.writeHead(200); res.end();                         // ack first: the agent's turn can take seconds
  onUpdate(u);
}).listen(WEBHOOK_PORT, () => log({ event: 'listening', webhook: `${PUBLIC_URL || '(PUBLIC_URL unset)'}/telegram`, agent: A2A_URL,
                           allowed: [...ALLOWED] }));

// :8081 on loopback only: kubectl exec into this pod is the only way in. The
// Service does not expose it, and binding 127.0.0.1 also keeps other pods,
// which can reach any pod IP, from starting an LLM turn or a setWebhook.
createServer(async (req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (req.method === 'POST' && req.url === '/register') {
    if (!PUBLIC_URL) { res.writeHead(400); return res.end('PUBLIC_URL is not set\n'); }
    try {
      // a throwaway Session: registration is not part of any chat
      const t = await turn(undefined, `[setup] Register your Telegram webhook: call the telegram set_webhook tool with url=${PUBLIC_URL}/telegram, then call get_webhook_info and report both results in one line.`);
      log({ event: 'register', state: t.state, contextId: t.contextId, ms: t.ms, reply: t.reply.slice(0, 200) });
      res.writeHead(t.state === 'TASK_STATE_COMPLETED' ? 200 : 502); return res.end(`${t.state}: ${t.reply}\n`);
    } catch (e) { res.writeHead(500); return res.end(`${describe(e)}\n`); }
  }
  res.writeHead(404); res.end();
}).listen(ADMIN_PORT, '127.0.0.1');
