#!/usr/bin/env bash
# Stand up the whole demo on a laptop: kind cluster -> Substrate 1.0.0-rc2 + kagent 1.0.0-rc2
# (via the pinned kagent CLI) -> the 18-agent fleet.
#
#   ANTHROPIC_KEY_FILE=~/.anthropic_key ./install/up.sh
#
# Re-runnable. Needs: Docker with 8 GB of memory free, kind >= 0.33, kubectl, helm (the kagent CLI shells out to it), curl, shasum,
# node >= 20.3 (Scope and preflight use AbortSignal.any). No Go.
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=${CLUSTER:-substrate-day}
CTX=kind-$CLUSTER
KAGENT_VERSION=v1.0.0-rc2
KEYFILE=${ANTHROPIC_KEY_FILE:-$HOME/.anthropic_key}
BIN=install/bin
KUBECONFIG_FILE=install/kubeconfig-$CLUSTER   # isolated: the installer only ever sees this cluster

[ -s "$KEYFILE" ] || { echo "Anthropic key file $KEYFILE missing (set ANTHROPIC_KEY_FILE)"; exit 1; }
for t in docker kind kubectl helm curl shasum node; do command -v $t >/dev/null || { echo "missing: $t"; exit 1; }; done
node -e 'process.exit(typeof AbortSignal.any === "function" ? 0 : 1)' \
  || { echo "node $(node --version) is too old: Scope needs node >= 20.3"; exit 1; }

# 1. kind cluster
if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --config install/kind-config.yaml
fi
# gVisor loopback pod-to-pod networking needs proxy ARP on the node
for node in $(kind get nodes --name "$CLUSTER"); do docker exec "$node" sysctl -q net.ipv4.conf.all.proxy_arp=1; done
kind get kubeconfig --name "$CLUSTER" > "$KUBECONFIG_FILE"; chmod 600 "$KUBECONFIG_FILE"

# 2. kagent CLI, pinned and checksum-verified
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) asset=kagent-darwin-arm64 ;; Darwin-x86_64) asset=kagent-darwin-amd64 ;;
  Linux-x86_64) asset=kagent-linux-amd64 ;;  Linux-aarch64) asset=kagent-linux-arm64 ;;
  *) echo "unsupported platform"; exit 1 ;;
esac
mkdir -p "$BIN"
if [ ! -x "$BIN/kagent" ]; then
  base=https://github.com/kagent-dev/kagent/releases/download/$KAGENT_VERSION
  curl -fsSL "$base/$asset" -o "$BIN/$asset"
  want=$(curl -fsSL "$base/$asset.sha256" | awk '{print $1}')
  got=$(shasum -a 256 "$BIN/$asset" | awk '{print $1}')
  [ "$want" = "$got" ] || { echo "checksum mismatch for $asset"; rm -f "$BIN/$asset"; exit 1; }
  mv "$BIN/$asset" "$BIN/kagent"; chmod +x "$BIN/kagent"
fi

# 3. Substrate + kagent (the CLI installs Substrate, PostgreSQL, certificates, then kagent)
printf 'install:\n  defaultModelProvider: Anthropic\n  kagent:\n    valuesFiles: [%s]\n' "$PWD/install/kagent-values.yaml" > install/kagent-cli-config.yaml
ANTHROPIC_API_KEY="$(tr -d '[:space:]' < "$KEYFILE")" KUBECONFIG="$KUBECONFIG_FILE" \
  "$BIN/kagent" install --config install/kagent-cli-config.yaml --timeout 15m

# 4. The fleet: 13 general agents on kagent-default, 5 on-call agents on their own pool
kubectl --context "$CTX" apply -f deploy/fleet.yaml
kubectl --context "$CTX" apply -f deploy/oncall-tools.yaml   # read-only k8s tools (no Secrets) for on-call
kubectl --context "$CTX" rollout status deploy/oncall-tools -n kagent --timeout=3m
# sre-oncall's template names the telegram RemoteMCPServer (headersFrom Secret
# telegram-bot) and the telegram-channel prompt ConfigMap: without them it never
# becomes Ready. Install the in-cluster Telegram plumbing OFFLINE: placeholder
# token, empty allowlist, no tunnel, no webhook. Create-if-missing only, so a
# re-run never clobbers what deploy/telegram-up.sh set (a real token, URL, allowlist).
K() { kubectl --context "$CTX" "$@"; }
K get secret telegram-bot -n kagent >/dev/null 2>&1 \
  || K create secret generic telegram-bot -n kagent --from-literal=token=unset >/dev/null
K get secret telegram-webhook -n kagent >/dev/null 2>&1 \
  || node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))' \
     | K create secret generic telegram-webhook -n kagent --from-file=secret=/dev/stdin >/dev/null
K get configmap telegram-config -n kagent >/dev/null 2>&1 \
  || K create configmap telegram-config -n kagent --from-literal=PUBLIC_URL= \
       --from-literal=TELEGRAM_ALLOWED_CHATS= --from-literal=WEBHOOK_IP= >/dev/null
K create configmap telegram-src -n kagent --from-file=telegram/doorbell.mjs --from-file=telegram/mcp.mjs \
  --dry-run=client -o yaml | K apply -f - >/dev/null
K apply -f deploy/telegram.yaml
kubectl --context "$CTX" apply -f deploy/oncall.yaml
kubectl --context "$CTX" wait --for=condition=Ready agents.api.kagent.dev --all -n kagent --timeout=10m

echo
echo "Installed in $((SECONDS / 60))m$((SECONDS % 60))s."
echo "Ready. Start the board:   KUBE_CONTEXT=$CTX node scope/server.mjs --live   # http://127.0.0.1:8123"
echo "Telegram beat (optional): TELEGRAM_PUBLIC_URL=https://<your tunnel host> KUBE_CONTEXT=$CTX ./deploy/telegram-up.sh   # see telegram/README.md"
echo "Before any talk:          KUBE_CONTEXT=$CTX ./deploy/preflight.sh"
