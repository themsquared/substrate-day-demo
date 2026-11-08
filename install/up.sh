#!/usr/bin/env bash
# Stand up the whole demo on a laptop: kind cluster -> Agent Substrate 1.0.0 + kagent 1.0.0-rc3
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
KAGENT_VERSION=v1.0.0-rc3   # pairs with Agent Substrate 1.0.0 (the CLI pins the Substrate charts and worker image)
KEYFILE=${ANTHROPIC_KEY_FILE:-$HOME/.anthropic_key}
BIN=install/bin
KUBECONFIG_FILE=install/kubeconfig-$CLUSTER   # isolated: the installer only ever sees this cluster

[ -s "$KEYFILE" ] || { echo "Anthropic key file $KEYFILE missing (set ANTHROPIC_KEY_FILE)"; exit 1; }
for t in docker kind kubectl helm curl shasum node; do command -v $t >/dev/null || { echo "missing: $t"; exit 1; }; done
node -e 'process.exit(typeof AbortSignal.any === "function" ? 0 : 1)' \
  || { echo "node $(node --version) is too old: Scope needs node >= 20.3"; exit 1; }

# 1. kind cluster
echo "cluster: $CLUSTER (context $CTX); pick another with CLUSTER=<name>"
if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --config install/kind-config.yaml
else
  # a cluster that exists but whose node container was stopped (docker stop) must be started first
  for node in $(kind get nodes --name "$CLUSTER"); do
    if [ "$(docker inspect -f '{{.State.Running}}' "$node")" != "true" ]; then
      echo "node $node is stopped; starting it"; docker start "$node" >/dev/null
    fi
  done
  for i in $(seq 1 60); do kubectl --context "$CTX" get --raw /readyz >/dev/null 2>&1 && break; sleep 2; done
  kubectl --context "$CTX" get --raw /readyz >/dev/null 2>&1 || { echo "cluster $CLUSTER exists but its API server did not come up; delete it with: kind delete cluster --name $CLUSTER"; exit 1; }
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
# Re-download when the pin moves: an older CLI in install/bin would install an older stack.
if ! { [ -x "$BIN/kagent" ] && "$BIN/kagent" version 2>/dev/null | grep -q "\"kagent_version\":\"${KAGENT_VERSION#v}\""; }; then
  rm -f "$BIN/kagent"
  base=https://github.com/kagent-dev/kagent/releases/download/$KAGENT_VERSION
  curl -fsSL "$base/$asset" -o "$BIN/$asset"
  want=$(curl -fsSL "$base/$asset.sha256" | awk '{print $1}')
  got=$(shasum -a 256 "$BIN/$asset" | awk '{print $1}')
  [ "$want" = "$got" ] || { echo "checksum mismatch for $asset"; rm -f "$BIN/$asset"; exit 1; }
  mv "$BIN/$asset" "$BIN/kagent"; chmod +x "$BIN/kagent"
fi

# 3. Substrate + kagent. The CLI installs, in order: kagent-crds, substrate-crds, the
# certificate controller (substrate-podcert), PostgreSQL, atelet as its own release
# (substrate-atelet, waited for), Substrate with atelet.enabled=false, then kagent.
# It enables the Substrate preview gates PerTemplateSnapshotLocation and
# GoldenEgressPolicy (kagent 1.0.0-rc3 needs both) and sets the kagent-default
# pool's worker image to the Substrate version it pairs with (ateworker-gvisor:v1.0.0).
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
# deploy/oncall.yaml pins the on-call pool's worker image (currently the rc2 image the
# live cluster runs). Substrate's version skew policy does not allow a worker older
# than ate-api-server, so give the pool the image the installer gave kagent-default.
WORKER_IMAGE=$(K get workerpools.ate.dev kagent-default -n kagent -o jsonpath='{.spec.workerImage}')
[ -n "$WORKER_IMAGE" ] || { echo "WorkerPool kagent/kagent-default has no workerImage"; exit 1; }
sed "s#^\(  workerImage: \).*#\1$WORKER_IMAGE#" deploy/oncall.yaml | K apply -f -
kubectl --context "$CTX" wait --for=condition=Ready agents.api.kagent.dev --all -n kagent --timeout=10m

echo
echo "Installed in $((SECONDS / 60))m$((SECONDS % 60))s."
echo "Ready. Start the board:   KUBE_CONTEXT=$CTX node scope/server.mjs --live   # http://127.0.0.1:8123"
echo "Telegram beat (optional): TELEGRAM_PUBLIC_URL=https://<your tunnel host> KUBE_CONTEXT=$CTX ./deploy/telegram-up.sh   # see telegram/README.md"
echo "Before any talk:          KUBE_CONTEXT=$CTX ./deploy/preflight.sh"
