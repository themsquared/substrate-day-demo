# sre-oncall on Telegram (kagent 1.0.0-rc2 / Substrate 1.0.0-rc2)

Message a Telegram bot from a phone. The agent `sre-oncall` restores from its
snapshot on its own worker pool, looks at the cluster, answers on Telegram with
its own bot, and checkpoints again. The bot token is never in the sandbox.

## Flow

```
 phone ──Telegram──▶ api.telegram.org
                          │ webhook POST  + X-Telegram-Bot-Api-Secret-Token
                          ▼
              https://oncall-bot.example.com/telegram          (Cloudflare edge, proxied DNS)
                          │ named tunnel, ONE connector: deploy/telegram-tunnel.yaml (in cluster)
                          ▼
   telegram-doorbell.kagent.svc.cluster.local:8080    telegram/doorbell.mjs (always on, ~10m CPU)
     1. timingSafeEqual(secret)      wrong/missing  -> 401, log "refused"
     2. chat_id in TELEGRAM_ALLOWED_CHATS?  no      -> 200, log "ignored chat_id=…"
     3. ack 200 to Telegram, then queue the turn (one at a time per chat);
        a refused/unreachable controller is retried for up to 90 s, a cut-off connection once
                          │ POST /agents/kagent/sre-oncall   JSON-RPC SendMessage, A2A-Version: 1.0
                          │ text "[telegram chat_id=… from=…] <message>", contextId = this chat's Session
                          ▼
   kagent-controller:8083 (A2A gateway) ──▶ Substrate: restore Session actor on pool kagent-oncall
                          │
                          ▼
   sre-oncall (gVisor sandbox, worker kagent-oncall-…)
     - read-only k8s tools  ──egress──▶ kagent-tools:8084
     - telegram send_typing / send_message
         runtime sends  x-telegram-bot-token: kagent-credential-injected   (placeholder, 26 chars)
                          ▼
   atenet-egress (ate-system): rule for http://telegram-mcp.kagent.svc.cluster.local:8080
         swaps the placeholder for ate-secret://k8s.io/default/kagent/telegram-bot/token (46 chars)
                          ▼
   telegram-mcp.kagent.svc.cluster.local:8080   telegram/mcp.mjs (no token of its own; own chat allowlist)
                          │ https://api.telegram.org/bot<token>/sendMessage
                          ▼
                       phone
   then: task COMPLETED -> Session lifecycle worker checkpoints the actor (~30 ms) -> worker freed
   doorbell: no send_message call in the task's artifacts -> one "[undelivered chat_id=…]" turn on the
             same Session; still not delivered -> log {"event":"undelivered", why, error}
```

The doorbell never answers the person itself (it has no bot token). It reads
the task's `function_call` / `function_response` artifacts to check that the
agent called `send_message` and that telegram-mcp accepted it. Each turn logs
`"sent":"ok" | "failed" | "no"`. During rehearsals, `grep undelivered` on the
doorbell log must return nothing.

## Files

| File | What |
|---|---|
| `telegram/doorbell.mjs` | Webhook receiver. Zero deps. Secret check, chat allowlist, chat -> Session map, A2A JSON-RPC `SendMessage`, delivery check, `/register` on admin 127.0.0.1:8081 (kubectl exec only). |
| `telegram/mcp.mjs` | Telegram MCP server (streamable HTTP, JSON). Tools `send_message`, `send_typing`, `set_webhook`, `get_webhook_info`. Logs every request with the token header's presence and length only. |
| `deploy/telegram.yaml` | Prompt fragment `telegram-channel`, telegram-mcp, RemoteMCPServer `telegram` (headersFrom Secret `telegram-bot`), doorbell. |
| `deploy/oncall.yaml` | WorkerPool `kagent-oncall` (1 replica), Harness `kagent-oncall`, Agents `sre-oncall`, `db-oncall`, `net-oncall`, `sec-oncall`, `platform-oncall`. Only `sre-oncall` names the telegram server. |
| `deploy/telegram-tunnel.yaml` | In-cluster cloudflared for the named tunnel. |
| `deploy/telegram-up.sh` | Secrets from files via stdin, ConfigMaps, dry-run, apply, roll, wait. |

## Bring it up

```sh
cd ~/substrate-scope
./deploy/telegram-up.sh            # context kind-substrate-day; PUBLIC_URL https://oncall-bot.example.com
```

It reads `~/.telegram_bot_token` and `~/.cloudflared_tunnel_token` on stdin
(never printed), keeps an existing webhook secret, PUBLIC_URL and allowlist,
and applies `telegram.yaml` before `oncall.yaml` (sre-oncall needs the
`telegram-channel` ConfigMap and the `telegram` RemoteMCPServer to be Ready).

Never run cloudflared on the Mac, and never run this tunnel's connector in two
clusters at once: a second connector splits traffic and some requests 502.

### Checks

```sh
C=kind-substrate-day
kubectl --context $C get agents.api.kagent.dev -n kagent -l scope.demo/pool=oncall      # 5 x READY True
kubectl --context $C get remotemcpserver telegram -n kagent                             # ACCEPTED True (4 tools)
kubectl --context $C get workerpools.ate.dev kagent-oncall -n kagent                    # READY 1
kubectl --context $C port-forward -n kagent deploy/telegram-tunnel 22000:2000 &
curl -s localhost:22000/ready                                                           # {"status":200,"readyConnections":4,...}
curl -s https://oncall-bot.example.com/healthz                                         # ok
```

### Troubleshooting: Telegram says "IPv6-only addresses are not allowed"

The tunnel's public hostname must be a **Proxied** (orange cloud) CNAME. As a DNS-only (grey cloud)
record it points at `<tunnel-id>.cfargotunnel.com`, which resolves only to a private IPv6 address, and
`setWebhook` fails with `bad webhook: IPv6-only addresses are not allowed`.

```sh
dig oncall-bot.example.com A @1.1.1.1 +short      # want Cloudflare A records, not just a CNAME
curl -s https://oncall-bot.example.com/healthz    # want: ok
```

Fix: Cloudflare dashboard -> your zone -> DNS -> the hostname -> Proxy status **Proxied**.
Telegram can keep the old DNS answer cached for a while after the fix. If `setWebhook` still fails,
pin delivery to one of the hostname's Cloudflare IPv4 addresses (Telegram's `ip_address` parameter):
`TELEGRAM_WEBHOOK_IP=<ipv4> ./deploy/telegram-up.sh`, then `./deploy/telegram-up.sh --register`.

## Allowlist: find the user's chat id

`TELEGRAM_ALLOWED_CHATS` is empty, so the doorbell ignores every chat and
telegram-mcp refuses to message any chat. To discover the chat id:

1. Register the webhook (below), then message the bot from the phone.
2. Read the doorbell log:
   ```sh
   kubectl --context kind-substrate-day logs -n kagent deploy/telegram-doorbell | grep ignored
   # {"event":"ignored","chat_id":"123456789","from":"Mike @…","hint":"add this chat id …"}
   ```
3. Allow it (rolls both pods; both read the same ConfigMap):
   ```sh
   TELEGRAM_ALLOWED_CHATS=123456789 ./deploy/telegram-up.sh
   ```

## Register the webhook (NOT done by the port; changes Telegram state)

Pick one. Both set the webhook secret, so the doorbell accepts Telegram's
deliveries and refuses everyone else.

A. Let the agent do it with its own tool (one LLM turn; demonstrates the egress-injected token):

```sh
./deploy/telegram-up.sh --register
# 200 TASK_STATE_COMPLETED: webhook registered: oncall-bot.example.com · url: oncall-bot.example.com · pending: 0
```

It first checks `https://oncall-bot.example.com/healthz` from the Mac. While that does not
answer `ok` (the DNS blocker above), it stops with the fix and does not run the LLM turn or
`setWebhook`. `SKIP_PUBLIC_CHECK=1` overrides it.

B. Directly with curl. The token and secret go through curl's stdin config
(`-K -`), so they are not in the process list or the terminal:

```sh
{ printf 'url = "https://api.telegram.org/bot%s/setWebhook"\n' "$(tr -d '[:space:]' < ~/.telegram_bot_token)"
  printf 'data-urlencode = "secret_token=%s"\n' "$(kubectl --context kind-substrate-day get secret telegram-webhook -n kagent -o jsonpath='{.data.secret}' | base64 -d)"
  printf 'data-urlencode = "url=https://oncall-bot.example.com/telegram"\n'
  printf 'data-urlencode = "allowed_updates=[\\"message\\"]"\n'
} | curl -sS -K -
# {"ok":true,"result":true,"description":"Webhook was set"}

# check it
printf 'url = "https://api.telegram.org/bot%s/getWebhookInfo"\n' "$(tr -d '[:space:]' < ~/.telegram_bot_token)" | curl -sS -K -
```

## Send a real Telegram message (NOT done by the port)

From the phone: message the bot, e.g. "is anything crashlooping?". Or, to
check the bot can reach the chat without the agent:

```sh
CHAT=123456789   # from the allowlist step
{ printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$(tr -d '[:space:]' < ~/.telegram_bot_token)"
  printf 'data-urlencode = "chat_id=%s"\n' "$CHAT"
  printf 'data-urlencode = "text=sre-oncall bot check"\n'
} | curl -sS -K -
```

Watch it live:

```sh
kubectl --context kind-substrate-day logs -n kagent deploy/telegram-doorbell -f      # ring -> session -> done (state, ms, sent)
kubectl --context kind-substrate-day logs -n kagent deploy/telegram-mcp -f           # tools/call send_typing / send_message, token "injected" len 46
```

A good rehearsal: the doorbell logs `"event":"done", … "sent":"ok"` and no `undelivered`, and
telegram-mcp logs `{"tool":"send_message", … "ok":true}`. Do 3 to 5 before the talk.

## Test without a phone (what the port verified)

Synthetic update from a chat that is not allowlisted, through Cloudflare (use
the `--resolve` form until the DNS record is proxied):

```sh
umask 077; H=$(mktemp)
{ printf 'X-Telegram-Bot-Api-Secret-Token: '; kubectl --context kind-substrate-day get secret telegram-webhook -n kagent -o jsonpath='{.data.secret}' | base64 -d; echo; } > $H
curl -s -o /dev/null -w '%{http_code}\n' -H @$H -H 'content-type: application/json' \
  -d '{"update_id":900000001,"message":{"message_id":1,"chat":{"id":555000111,"type":"private"},"from":{"first_name":"Synthetic"},"text":"hi"}}' \
  https://oncall-bot.example.com/telegram          # 200, doorbell logs {"event":"ignored","chat_id":"555000111",…}
rm -f $H
```

A2A path end to end, with a throwaway doorbell inside the doorbell pod that
allowlists a fake chat (telegram-mcp still refuses that chat, so nothing reaches
Telegram):

```sh
kubectl --context kind-substrate-day exec -n kagent deploy/telegram-doorbell -- sh -c '
WEBHOOK_PORT=18080 ADMIN_PORT=18081 TELEGRAM_ALLOWED_CHATS=555000222 TELEGRAM_WEBHOOK_SECRET=localtest timeout 90 node /app/doorbell.mjs > /tmp/t.log 2>&1 &
sleep 1
wget -qO- --header="X-Telegram-Bot-Api-Secret-Token: localtest" --header="content-type: application/json" \
  --post-data="{\"update_id\":1,\"message\":{\"message_id\":1,\"chat\":{\"id\":555000222},\"from\":{\"first_name\":\"Test\"},\"text\":\"is the kagent-oncall pool healthy?\"}}" \
  http://127.0.0.1:18080/telegram
sleep 20; cat /tmp/t.log'
```

Expected for that fake chat: `"sent":"failed"`, then `undelivered` with
`not on this bot's allowlist` (telegram-mcp refuses it). That proves the agent
called `send_message`. Only an allowlisted chat can show `"sent":"ok"`.

Measured 2026-11-04 on kind-substrate-day (claude-haiku-4-5):

| Step | Latency |
|---|---|
| Public webhook POST through Cloudflare -> doorbell ack (401 / 200) | 0.14-0.21 s |
| Session actor restore on kagent-oncall (first turn / second turn) | 271 ms / 141 ms |
| Turn 1 (new Session, typing tool + k8s tools + answer), doorbell `SendMessage` round trip | 8.98 s |
| Turn 2 (same contextId) | 2.97 s |
| Checkpoint after each turn | ~31 ms |

## rc2 specifics (what changed from the enterprise beat)

- Invocation: enterprise gRPC-Web `AgentInstanceService` + `A2AService/SendStreamingMessage`
  became one JSON-RPC `POST /agents/kagent/sre-oncall`, method `SendMessage`,
  header `A2A-Version: 1.0` (without it: `-32009 VERSION_NOT_SUPPORTED`). No token
  minting: the OSS controller runs auth mode insecure. The `kagent` namespace already has
  `ate.dev/api-access=true`; the doorbell needs no extra label.
- A Session is created by sending without `contextId`; `result.task.contextId` continues it.
  The doorbell keeps chat -> contextId in memory; a doorbell restart starts new Sessions.
- `AgentTemplate` + `kagent.dev/v1alpha3` became `Agent` (`api.kagent.dev/v1alpha3`) with
  `spec.template.inline` and a required `harnessRef`; a second pool needs its own Harness with
  `snapshotPolicy.location`.
- An externally managed WorkerPool must carry `kagent.dev/worker-pool-name` and
  `kagent.dev/worker-pool-namespace`, or generated ActorTemplates never select its workers.
- RemoteMCPServer URLs must be full DNS names (`*.svc.cluster.local`): rc2 allows DNS only for
  hostnames in the actor's egress policy.
- `headersFrom` with a Secret is supported in OSS rc2 and is compiled into the revision as
  `{origin: http://telegram-mcp.kagent.svc.cluster.local:8080, header: x-telegram-bot-token,
  uri: ate-secret://k8s.io/default/kagent/telegram-bot/token}`. The gateway replaces a header the
  runtime sends; it does not add a missing one (the managed MCP client sends the placeholder).
  Requires the credential-provider grant `atespace kagent -> namespace kagent` (installed).
- Prompt-library ConfigMaps no longer need a label; `promptTemplate.dataSources` names them.

## Exactly who sees the bot token

- Sandbox / agent runtime: never. The compiled revision in PostgreSQL holds only the
  `ate-secret://` reference (verified: 0 occurrences of the token in a full `pg_dump` of the
  kagent DB). The sandbox's MCP calls reach telegram-mcp from the atenet-egress pod's IP with
  the header already replaced (46 chars).
- atenet-egress + k8s-credential-provider (ate-system): fetch and inject it per call.
- kagent-controller: reads the Secret for **tool discovery** and calls telegram-mcp directly with
  it (seen in telegram-mcp's log from the controller's IP). That is the control plane, not the
  sandbox. To make egress the only path, label the server
  `kagent.dev/discovery: disabled`; the agent then discovers tools at runtime and the UI's tool
  list for this server stays empty.
- telegram-mcp: receives it per request, uses it in the Bot API URL path, never logs or stores it.
- Only `sre-oncall`'s revision has an egress rule for telegram-mcp; the other four on-call
  agents (and every other agent) cannot even resolve its DNS name from their sandboxes.
