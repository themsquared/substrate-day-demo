# kubectl is lying to you — the demo

The live demo from **"kubectl is lying to you: what a live visualizer taught me about Agent Substrate"**
(Mike Moore, Agent Substrate Day, November 9, 2026). Everything you saw on stage, runnable on a laptop.

- **Substrate Scope** (`scope/`): a live board that shows agents as snapshot-backed actors moving between
  object storage, the router's parking lot, and gVisor worker bays. Its buttons act on the real cluster.
- **An 18-agent fleet** (`deploy/`): 13 general agents on `kagent-default`, 5 on-call agents on an isolated `kagent-oncall` pool.
- **A Telegram on-call agent** (`telegram/`): text a bot from your phone; `sre-oncall` restores from its snapshot,
  answers with its own Telegram tool, and suspends again. The bot token is injected by Substrate egress and never enters the sandbox.
- **The slides** (`slides/kubectl-is-lying-public.pdf`).

| Version pin | |
| --- | --- |
| kagent | `1.0.0-rc3` (CLI `v1.0.0-rc3`, checksum-verified) |
| Agent Substrate | `1.0.0` (kagent-dev/substrate charts `substrate-crds`, `substrate-podcert`, `substrate-atelet`, `substrate`; upstream agent-substrate `v1.0.0`) |
| Kubernetes | `1.37.0` on kind (`kindest/node` pinned by digest) |
| Model | Anthropic `claude-haiku-4-5` |

## Prerequisites

| | Needed | Tested with |
| --- | --- | --- |
| Docker | 8 GB of memory and 5 GB of disk free for the kind node (idle it uses ~2.3 GiB; each running agent adds up to 1 GiB, 4 at most) | Docker Desktop, 31 GiB VM, Apple silicon |
| kind | v0.33 or newer (the node image is `kindest/node:v1.37.0`, pinned by digest) | v0.33.0 |
| kubectl | any recent client | v1.36.1 |
| Helm | on `PATH`: the kagent CLI runs it to install the charts | v4.0.4 |
| Node.js | 20.3 or newer (Scope and the preflight use `AbortSignal.any`); no npm install, zero dependencies | v25.2.1 |
| curl, shasum | to download and checksum-verify the kagent CLI | macOS built-ins |
| Anthropic API key | in a file, read on stdin and stored only in Secret `kagent-anthropic` | `claude-haiku-4-5` |

You do **not** need Go, a kagent checkout, or a GPU. The installer downloads the pinned kagent CLI into
`install/bin/` and uses an isolated kubeconfig (`install/kubeconfig-<cluster>`) for it.

## Quickstart

```bash
git clone https://github.com/themsquared/substrate-day-demo.git
cd substrate-day-demo
ANTHROPIC_KEY_FILE=~/.anthropic_key ./install/up.sh          # kind cluster "substrate-day", context kind-substrate-day
KUBE_CONTEXT=kind-substrate-day node scope/server.mjs --live  # the board: http://127.0.0.1:8123
KUBE_CONTEXT=kind-substrate-day ./deploy/preflight.sh         # health check + one real (billable) agent turn
```

`CLUSTER=<name> ./install/up.sh` picks another cluster name (context `kind-<name>`). The installer is
re-runnable: on an existing cluster it reconciles in about 10 seconds. Note that `kind create cluster`
switches your current kubectl context to the new cluster.

What `install/up.sh` does, and how long it took from scratch (one clean run of this stack on the machine above,
with the `kindest/node` image already pulled; the first pull of that image adds a few minutes, and the in-cluster
image pulls depend on your network):

| Step | Time |
| --- | --- |
| kind cluster (1 node, Kubernetes 1.37.0) | ~10 s |
| kagent CLI download + checksum, then `kagent install`: Substrate CRDs, certificate controller, PostgreSQL, atelet (its own `substrate-atelet` release since kagent 1.0.0-rc3), Substrate, kagent | ~4.5 min |
| The fleet: Harness `kagent`, 13 agents on `kagent-default`, read-only on-call tools, offline Telegram plumbing, pool `kagent-oncall` + 5 on-call agents, all Ready | ~50 s |
| **Total** | **~5.5 min** (measured 5m22s; the rc2 stack measured 4m10s and 6m01s) |

When it finishes you have 18 Agents, all Ready, on **two worker pods** (one per WorkerPool, each sized
2 CPU / 2304 Mi, so each holds 2 actors at kagent's 1 CPU / 1 Gi booking). No agent runs until you chat with it.
Both pools run the worker image the installer pairs with its Substrate (`ateworker-gvisor:v1.0.0`): `up.sh`
copies it from `kagent-default` onto `kagent-oncall`, because Substrate's version skew policy does not allow a
worker older than `ate-api-server`.

The Telegram beat is optional. `up.sh` installs its in-cluster parts offline (placeholder bot token, empty
allowlist, no tunnel, no webhook) so `sre-oncall` is Ready; `deploy/telegram-up.sh` turns it on with your
own bot and Cloudflare tunnel (see `telegram/README.md`). Run only one tunnel connector per tunnel.

To remove everything: `kind delete cluster --name substrate-day`.
