#!/usr/bin/env bash
# sre-oncall on Telegram, kagent 1.0.0-rc2 (see telegram/README.md for the flow).
#
#   TELEGRAM_PUBLIC_URL=https://oncall-bot.example.com ./deploy/telegram-up.sh   # your tunnel hostname (kept in ConfigMap telegram-config)
#   TELEGRAM_ALLOWED_CHATS=123456789 ./deploy/telegram-up.sh  # let a chat reach the agent
#   ./deploy/telegram-up.sh --register                        # ask sre-oncall to (re)register its webhook (one real LLM turn)
#
# Applies, in order: Secrets + ConfigMaps, deploy/telegram.yaml (prompt fragment,
# telegram-mcp, RemoteMCPServer telegram, doorbell), deploy/oncall.yaml (pool
# kagent-oncall, Harness kagent-oncall, five on-call Agents incl. sre-oncall),
# then deploy/telegram-tunnel.yaml when a tunnel token exists.
#
# Reads (never prints) these files, when present, through stdin:
#   ~/.telegram_bot_token          from @BotFather        -> Secret telegram-bot
#   ~/.cloudflared_tunnel_token    Zero Trust tunnel token -> Secret cloudflared-tunnel
# Without the bot token, the Secret holds a placeholder so sre-oncall stays
# Ready (its template binds the telegram server); the tools just fail.
# Re-run it any time: it keeps the webhook secret, PUBLIC_URL and an allowlist
# it already has.
set -euo pipefail
cd "$(dirname "$0")"
C=${KUBE_CONTEXT:-kind-substrate-day}
K() { kubectl --context "$C" "$@"; }
BOT_FILE=${TELEGRAM_BOT_TOKEN_FILE:-$HOME/.telegram_bot_token}
TUNNEL_FILE=${CLOUDFLARED_TOKEN_FILE:-$HOME/.cloudflared_tunnel_token}
DEFAULT_URL=   # no default: set TELEGRAM_PUBLIC_URL once; later runs reuse ConfigMap telegram-config

if [ "${1:-}" = --register ]; then
  URL=$(K get configmap telegram-config -n kagent -o jsonpath='{.data.PUBLIC_URL}' 2>/dev/null || true); URL=${URL:-$DEFAULT_URL}
  # Telegram must reach this URL from the internet. If it does not answer from
  # here either (DNS-only record, tunnel down), stop before the paid LLM turn
  # and a setWebhook that would leave the bot pointing at a dead URL.
  if [ "${SKIP_PUBLIC_CHECK:-0}" != 1 ] && [ "$(curl -sS -m 10 "${URL%/}/healthz" 2>/dev/null || true)" != ok ]; then
    host=${URL#https://}; host=${host%%/*}
    echo "not registering: ${URL%/}/healthz does not answer 'ok' from here, so Telegram cannot deliver to it either."
    echo "  dig $host A @1.1.1.1 +short    # must return Cloudflare A records, not only the *.cfargotunnel.com CNAME"
    echo "  fix: Cloudflare DNS -> $host -> Proxy status Proxied (orange cloud); see telegram/README.md"
    echo "  (SKIP_PUBLIC_CHECK=1 ./deploy/telegram-up.sh --register to register anyway)"
    exit 1
  fi
  echo "public URL : ${URL%/}/healthz ok"
  echo "asking sre-oncall to register its webhook (one real turn)..."
  K exec -n kagent deploy/telegram-doorbell -- wget -qO- --post-data= http://127.0.0.1:8081/register
  exit
fi

# Secrets. The bot token and tunnel token come from files, on stdin, so they
# never appear in a process list, a shell trace or this script's output.
secret_from_file() { local name=$1 file=$2
  K create secret generic "$name" -n kagent --from-file=token=/dev/stdin --dry-run=client -o yaml \
    < <(tr -d '[:space:]' < "$file") | K apply -f - >/dev/null; }
if [ -s "$BOT_FILE" ]; then secret_from_file telegram-bot "$BOT_FILE"; echo "bot token  : loaded from $BOT_FILE"
elif ! K get secret telegram-bot -n kagent >/dev/null 2>&1; then
  K create secret generic telegram-bot -n kagent --from-literal=token=unset >/dev/null
  echo "bot token  : none yet (placeholder; save it to $BOT_FILE and re-run)"
fi
if ! K get secret telegram-webhook -n kagent >/dev/null 2>&1; then
  openssl rand -hex 24 | tr -d '\n' | K create secret generic telegram-webhook -n kagent --from-file=secret=/dev/stdin >/dev/null
fi
tunnel=0
if [ -s "$TUNNEL_FILE" ]; then secret_from_file cloudflared-tunnel "$TUNNEL_FILE"; tunnel=1; echo "tunnel     : token loaded from $TUNNEL_FILE"
else echo "tunnel     : no token ($TUNNEL_FILE); no tunnel"; fi

# Config: keep what is already set unless overridden.
cur() { K get configmap telegram-config -n kagent -o jsonpath="{.data.$1}" 2>/dev/null || true; }
URL=${TELEGRAM_PUBLIC_URL:-$(cur PUBLIC_URL)}; URL=${URL:-$DEFAULT_URL}
CHATS=${TELEGRAM_ALLOWED_CHATS:-$(cur TELEGRAM_ALLOWED_CHATS)}
# Optional: pin Telegram webhook delivery to one IPv4 (setWebhook ip_address) when
# Telegram is still caching an old DNS answer for the hostname. Empty = use DNS.
WEBHOOK_IP=${TELEGRAM_WEBHOOK_IP:-$(cur WEBHOOK_IP)}
[ -z "$URL" ] && { echo "set TELEGRAM_PUBLIC_URL=https://<your tunnel hostname> (see telegram/README.md)"; exit 1; }
[[ "$URL" != https://* ]] && { echo "TELEGRAM_PUBLIC_URL must start with https://"; exit 1; }
K create configmap telegram-config -n kagent --from-literal=PUBLIC_URL="${URL%/}" \
  --from-literal=TELEGRAM_ALLOWED_CHATS="$CHATS" --from-literal=WEBHOOK_IP="$WEBHOOK_IP" --dry-run=client -o yaml | K label --local -f - demo=substrate-scope -o yaml \
  | K apply -f - >/dev/null

# Code, then the objects (server-side dry run first: a schema error stops here
# instead of half-applying). Roll the pods so they pick up new code or config.
K create configmap telegram-src -n kagent --from-file=../telegram/doorbell.mjs --from-file=../telegram/mcp.mjs \
  --dry-run=client -o yaml | K apply -f - >/dev/null
K apply --dry-run=server -f telegram.yaml >/dev/null
K apply -f telegram.yaml >/dev/null
K apply --dry-run=server -f oncall.yaml >/dev/null
K apply -f oncall.yaml >/dev/null
K rollout restart deploy/telegram-mcp deploy/telegram-doorbell -n kagent >/dev/null
[ "$tunnel" = 1 ] && K apply -f telegram-tunnel.yaml >/dev/null
K rollout status deploy/telegram-mcp -n kagent --timeout=120s >/dev/null
K rollout status deploy/telegram-doorbell -n kagent --timeout=120s >/dev/null
[ "$tunnel" = 1 ] && K rollout status deploy/telegram-tunnel -n kagent --timeout=120s >/dev/null
# rollout status returns while an old pod may still be terminating (and serving)
for _ in $(seq 1 30); do
  [ "$(K get pods -n kagent -l 'app in (telegram-mcp,telegram-doorbell)' --no-headers | wc -l | tr -d ' ')" = 2 ] && break; sleep 2
done
echo "on-call    : waiting for pool kagent-oncall and the five agents (golden snapshots)..."
K rollout status deploy/kagent-oncall -n kagent --timeout=180s >/dev/null 2>&1 || echo "  worker pool kagent-oncall not ready yet"
K wait agents.api.kagent.dev -n kagent -l scope.demo/pool=oncall --for=condition=Ready --timeout=300s >/dev/null \
  || echo "  not all on-call agents are Ready: kubectl --context $C get agents.api.kagent.dev -n kagent -l scope.demo/pool=oncall"

echo
echo "public URL : ${URL%/}  (webhook: ${URL%/}/telegram)"
echo "allowlist  : ${CHATS:-(empty: message the bot, then find your chat id with the command below)}"
echo "  kubectl --context $C logs -n kagent deploy/telegram-doorbell | grep ignored"
echo "webhook    : once the URL, the tunnel and a real bot token are in place, register it (one LLM turn):"
echo "  ./deploy/telegram-up.sh --register"
