# Ghost actor on rc2: a canceled resume leaves the actor in RESUMING, holding a worker slot

Status: analysis of a ghost-actor failure seen on kagent 1.0.0-rc2 + Substrate 1.0.0-rc2 while building this demo.
Rig: `kind-substrate-day`. Written 2026-11-04 (local, PST). All log timestamps are UTC.

Each claim has one of two labels:
- **[PROVEN]**: seen in live logs or state on this rig, or read directly in the source at the tag that is deployed.
- **[INFERRED]**: reasoned from code or timing and not tested directly.

---

## 1. Summary

During a SURGE (13 to 18 concurrent chats against 2 to 4 actor slots), some actors stay in
`ACTOR_STATE_RESUMING` and keep their worker slot until their worker pod is deleted. These are the "ghosts".

This happens in two steps. Both steps are needed to cause it.

1. **The router cancels an in-flight ResumeActor when the park budget ends.** [PROVEN]
   On this install, atenet-router is **agentgateway v1.7.0** with its native `substrateIngress` policy. It is not the
   Envoy + Go ext_proc router that `docs/concepts/request-parking.md` describes. agentgateway wraps every
   `ResumeActor` attempt in `tokio::time::timeout(remaining, …)`. When the 5 s budget ends during an attempt, the
   future is dropped and the gRPC stream is reset. ateapi then sees `context canceled` in the middle of
   `CallAteletRestore`. The doc says the opposite: "an attempt already in flight is never canceled".
   The Go router follows the doc, because it uses `context.WithoutCancel`. agentgateway does not.
2. **ateapi leaves the actor RESUMING and bound to its worker after a caller cancels, and nothing drives it again.** [PROVEN in code, observed live]
   `handleAteletError` keeps the assignment on purpose "so a retry can finish the operation". The assignment
   reconciler skips RESUMING actors on purpose ("left to its resume"). The router has already given up, and the
   client (Scope's retry and kagent) sends its retry to a *new* session. So the stranded actor never gets another
   ResumeActor. It keeps its booking on the worker until that worker pod is deleted. When the pod goes,
   `workflow_worker_delete` crashes the actor and releases the slot.

The race window is the time a restore needs (110 to 430 ms here) at the very end of the budget. Under a surge, the
window is hit often. Capacity usually arrives late in the budget, either because another actor suspends or because
the autoscaler adds pods. AssignWorker then succeeds only a few hundred ms before the deadline.

In the repro below, 5 requests used up the budget, and 3 of them became ghosts.

## 2. Versions (as deployed) [PROVEN]

| Component | Version / image |
|---|---|
| kagent controller | `ghcr.io/kagent-dev/kagent/controller:1.0.0-rc2` (Helm `kagent-1.0.0-rc2`) |
| Substrate (ateapi, atelet, worker) | `ghcr.io/kagent-dev/substrate/{ateapi,atelet,ateworker-gvisor}:v1.0.0-rc2`, Helm `substrate-1.0.0-rc2`; fork tag `v1.0.0-rc2` = `f0f214ae` ("sync/upstream-release-1.0-20261104") |
| Upstream Substrate | `agent-substrate/substrate` `v1.0.0-rc.2` = `e59281c7`. `cmd/ateapi/.../workflow_resume.go`, `crash.go` and the Go router `resumer.go` are byte-identical in the fork |
| atenet-router | `cr.agentgateway.dev/agentgateway:v1.7.0@sha256:60216aaf…` (startup log `git_revision: 26f5aebe…` = tag `v1.7.0`) |
| Router config | ConfigMap `ate-system/atenet-router-agentgateway-config`: `substrateIngress.requestParking.budget: "5s"` (max/retry left at their defaults) |
| Cluster | kind, Kubernetes v1.37.0, single node, linuxkit 7.0.14, sandbox class gvisor |
| Pools | WorkerPool `kagent-default` (13 agents) and `kagent-oncall` (5 agents), each 1 replica x 2 actor slots at rest. Scope autoscale was ON during the repro |

There is no Envoy in the data path. The `atenet-router` Deployment has a single `agentgateway` container. So the
"Envoy ext_proc timeout (budget + 5 s)" in the doc does not apply to this install. [PROVEN]

## 3. Exact repro steps

Prerequisites: the rig is at rest (each pool at 1 worker, 2 slots), Scope is running in `--live` mode on
`http://127.0.0.1:8123`, and DEMO is RUN.

```bash
# 0. optional: follow the logs that matter
kubectl --context kind-substrate-day -n ate-system logs -f deploy/atenet-router            > router.log &
kubectl --context kind-substrate-day -n ate-system logs -f <each ate-api-server pod> -c ate-api-server > api-<pod>.log &
kubectl --context kind-substrate-day -n ate-system logs -f ds/atelet -c atelet               > atelet.log &

# 1. one SURGE: Scope sends one chat to every Agent on kagent-default (13 chats, ~120-word answer each)
curl -s -X POST http://127.0.0.1:8123/surge
#   -> {"ok":true,"fired":13,"accepted":13,"refused":0,"targets":13,"stopped":false}

# 2. after about 40 s, when the queue and parking are back to 0, look at the board and the worker list:
curl -s http://127.0.0.1:8123/status | jq '.snapshot.workers[] | select(.actorId) | {pod,slot,actorTemplate,status,actorId}'
#   -> actors with status "Resuming" that never change are the ghosts

# 3. find one ghost in the logs
grep <actorId> router.log api-*.log atelet.log

# 4. clean up (RESET POOL)
curl -s -X POST -H 'content-type: application/json' -d '{"pool":"kagent-default"}' http://127.0.0.1:8123/reset
#   (same as: kubectl --context kind-substrate-day -n kagent rollout restart deploy/kagent-default)
```

Without Scope, the same thing should happen with more concurrent first messages than free slots. A first message is
an A2A `SendMessage` with no `contextId`, sent to `POST /agents/kagent/<agent>` on the controller (:8083). [INFERRED]
The ghost needs a restore to be in flight when the budget ends. So it happens most when capacity frees up 4.5 to 5 s
into the park.

### Repro run 2026-11-05 01:54:16Z (this investigation) [PROVEN]

- SURGE fired 13 chats. Scope autoscale scaled `kagent-default` from 1 to 7 pods. The new pods were Ready about
  01:54:21 to 22Z, which is 4.5 to 5 s into the park budget of the first requests.
- 5 router requests ended in budget exhaustion. For 3 of them, a restore was in flight, and each became a ghost:

| Actor (session) | Template | Worker pod | ResumeActor attempt started before the deadline | Restore time used before cancel |
|---|---|---|---|---|
| `session-01a1a969-fb03-7621-9d40-8af996fafbde` | incident-scribe | `kagent-default-…-g8xsd` | ~118 ms | 112 ms |
| `session-01a1a969-f99b-70b5-80e7-ec696e49f32e` | cost-warden | `kagent-default-…-h8jst` | ~212 ms | 191 ms |
| `session-01a1a969-fa14-7c3b-8180-0b954e991595` | doc-curator | `kagent-default-…-ww29n` | ~229 ms | 250 ms |

- All three showed `Resuming` on the board from 01:54:22Z. At 01:55:12Z, Scope's autoscaler scaled the pool from 7
  to 2. The ReplicaSet removed those three pods. ateapi logged "Releasing actor from a worker whose pod is gone",
  then "Actor crashed". The slots were freed after about 50 s. This was luck: the ghosts were on the newest pods, and
  those pods were removed first.
- RESET POOL was run afterwards as cleanup. The pool came back to 1 pod x 2 slots with no occupied slots.

### Earlier occurrence (re-walk) [PROVEN]

- `session-01a1a95f-6575-719c-bd2f-bb6a8e768534` (release-notary) was stuck at 01:42:48Z on
  `kagent-default-…-p5l22`. The pool had 1 replica, so no scale-down could clear it. It stayed `Resuming` until RESET
  POOL at 01:46:26Z (3.5 min). On this run, the attempt started ~430 ms before the deadline, and the restore had run
  410 ms when it was canceled.

## 4. Log excerpts [PROVEN]

These excerpts are for `session-01a1a969-fb03-7621-9d40-8af996fafbde`. The log fields are trimmed, but the values
are verbatim. No secrets appear in them. atelet already redacts the env values, and those lines are not quoted here.

**ateapi**: the actor is created at 01:54:17.48. Then about 20 `ResumeActor` attempts from the router fail at
AssignWorker (01:54:17.50 to 01:54:21.88), alternating between both ate-api-server replicas:
```
01:54:17.506 Handle RPC /substrate.ateapi.v1.Control/ResumeActor err="workflow failed at step AssignWorker: no worker has room for the actor" principal=spiffe://cluster.local/ns/ate-system/sa/atenet-router
...
01:54:21.881 Handle RPC /substrate.ateapi.v1.Control/ResumeActor err="workflow failed at step AssignWorker: no worker has room for the actor"
```
**ateapi (ate-api-server-…-ttd7p)**: the last attempt gets a worker, and the actor is stored RESUMING:
```
01:54:22.395 "Actor state changed" ate.actor.operation.name=resume ate.actor.state=resuming ate.template.name=incident-scribe-013f49078c71
01:54:22.478 Handle RPC /substrate.ateapi.v1.WorkerService/MintWorkerActorCertificate   (sandbox is booting)
```
**router (agentgateway)**: 5.004 s after the first attempt (= the budget), the router stops waiting and returns the
*previous* retry error:
```
01:54:22.507432Z warn  http::substrate::ingress  substrate ResumeActor failed  request.id=1017 actor="session-01a1a969-fb03-…" grpc.code=ResourceExhausted grpc.message="no worker has room for the actor"
01:54:22.507603Z error request route=default/substrate-actors-grpc src.identity=spiffe://cluster.local/ns/kagent/sa/kagent-controller http.path=/lf.a2a.v1.A2AService/SendMessage grpc.status=14 ate.router.resume=none ate.router.route.duration=5.004332753 error="no worker has room for the actor" reason=Internal duration=5004ms
```
**atelet**: 1 ms later, the restore is canceled under it. The cancel also reaches the worker's `RestoreWorkload`:
```
01:54:22.508759Z "Restore timing breakdown" ate.snapshot.kind=latest ate.sandbox.class=gvisor error.type=Canceled ate.actor.restore.duration.worker_restore=0.068 ate.actor.restore.duration.total=0.112
01:54:22.508886Z Handle RPC /atelet.Atelet/Restore err="while calling worker RestoreWorkload: rpc error: code = Canceled desc = context canceled: context canceled" elapsed-time=112.9ms
```
**ateapi**: the workflow fails and nothing changes the state back:
```
01:54:22.578 Handle RPC /substrate.ateapi.v1.Control/ResumeActor err="workflow failed at step CallAteletRestore: while calling atelet Restore: rpc error: code = Canceled desc = context canceled: context canceled" elapsed-time=188.7ms
```
**For the next 50 s**: there are no log lines for this actor at all. No component retries it.
**ateapi**: only when the worker pod is deleted does the actor get released:
```
01:55:12.873 "Reclaiming the node state of an actor released from a worker whose pod is gone" node=substrate-day-control-plane
01:55:12.874 "Releasing actor from a worker whose pod is gone"
01:55:12.878 ERROR "Actor crashed" ate.actor.operation.name=resume ate.actor.state=crashed
```

The other two ghosts follow the same sequence: route.duration 5.000964 s and 5.002120 s, the atelet Restore is
canceled 1 to 28 ms later, and the actor is crashed at 01:55:12.89Z. The re-walk ghost is the same too
(`route.duration=5.001397335`, and ateapi reports `CallAteletRestore … context canceled` after 443 ms).

## 5. Root-cause analysis

### 5.1 Who cancels: the router (agentgateway `substrateIngress`), when the park budget ends [PROVEN]

`agentgateway` tag `v1.7.0`, file `crates/agentgateway/src/http/substrate/ingress.rs`:

- `:329` `async fn resume_actor`, and `:335` `let deadline = tokio::time::Instant::now() + budget;`
- `:367` every attempt runs as `tokio::time::timeout(remaining, control.resume_actor(request))`, where `remaining`
  is the time left in the budget. When the timer fires, the tonic call future is **dropped**. That resets the HTTP/2
  stream, and ateapi's handler context is canceled.
- `:426-429` when the timeout fires, the router returns `last_retry_status`, the *previous* `ResourceExhausted`. That
  is why the router logs `grpc.code=ResourceExhausted` for an attempt that actually ended in `Canceled` on the server.
  This hides the real cause.
- `:417-421` between attempts, it sleeps `delay.min(remaining)`. So a retry can start a few ms before the deadline
  and still get only those few ms.
- `:503-506` `resume_actor` is awaited inline in the request's future and is not spawned. So a client disconnect
  would cancel an in-flight resume the same way. [INFERRED: this path was not seen in these logs]
- `RESUME_TIMEOUT` (15 s) at `:27` is used only when parking is disabled (`:267-275`).

These are the timing facts that rule out the other suspects:
- **kagent controller client context**: not the canceller. The router ended the request at exactly the budget
  (`route.duration` = 5.0010 to 5.0043 s) with its own verdict (`grpc.status=14`, `reason=Internal`). If the client
  had disconnected first, the request would have ended before the budget. Also, kagent's gateway sets no 5 s timeout
  on the actor `SendMessage` call. The only 5 s timeout there is `finishSend`'s
  `context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)`, which is used for `RevokeSend`
  (`go/core/internal/a2agateway/interactions.go:184`). [PROVEN in logs and code]
- **Envoy ext_proc timeout (budget + 5 s)**: there is no Envoy in this deployment, and the cancel comes at budget + 0
  s, not budget + 5 s. [PROVEN]

**The documented contract that is broken:** `docs/concepts/request-parking.md:54-63` in agent-substrate/substrate
v1.0.0-rc.2 says:
> "The budget bounds retries, not a committed resume. … an attempt already in flight is **never canceled** … a
> restore that overshoots the budget … is served late rather than failed."

The Go router follows this. `cmd/atenet/internal/router/ingress/resumer.go:214-219` runs the flight in its own
goroutine with `attemptCtx := context.WithoutCancel(bgCtx)`, and the budget only stops the backoff loop. The
agentgateway port does not do this.

Who ships agentgateway as the router: the **kagent-dev/substrate** Helm chart
(`charts/substrate/templates/atenet-router.yaml:110-113` `substrateIngress.requestParking.budget`, `:190` image
`.Values.images.agentgateway`). It deploys agentgateway as the only router option. Upstream kustomize uses Envoy + Go
by default (`manifests/ate-install/atenet-router.yaml`), and agentgateway there is an opt-in component
(`manifests/ate-install/components/agentgateway`). [PROVEN]

### 5.2 Why the actor stays RESUMING: there is no compensation and no owner [PROVEN in code]

Fork `kagent-dev/substrate` `v1.0.0-rc2`. These files are the same as upstream `v1.0.0-rc.2`.
Paths are under `cmd/ateapi/internal/controlapi/`.

1. `workflow_resume.go:86` `leaseCtx, lease, err := w.acquireActorLease(ctx, actorRef)`. The lease context is
   `context.WithCancel(<request ctx>)` (`cmd/ateapi/internal/store/atepg/lease.go:57`), so every later step is tied
   to the router's RPC.
2. `workflow_resume.go:481-486` `BindActorToWorker(…)` stores `State = RESUMING` and the `WorkerAssignment` in the
   same transaction. From here on, the worker's slot is booked.
3. `workflow_resume.go:124` → `ensureAteletRestored` → `:814` `client.Restore(ctx, req)` runs on the canceled
   context → `:823` `handleAteletError(…)`.
4. `crash.go:96-100`:
   ```go
   // The caller went away or its deadline passed: report that, not atelet's
   // error. The actor keeps its assignment, so a retry can finish the operation.
   if ctx.Err() != nil {
       return fmt.Errorf("while calling atelet %s: %w: %w", rpc, err, ctx.Err())
   }
   ```
   This is by design: no rollback to SUSPENDED and no release of the booking. Recovery depends on **someone calling
   ResumeActor again** for this actor. `ensureWorkerAssigned` would then skip ahead from RESUMING
   (`workflow_resume.go:242-248`).
5. Nobody else will call it. The only background path that looks at worker assignments skips this case on purpose:
   `workflow_reconcile_assignments.go:176-182`:
   ```go
   if actor.GetStatus().GetState() == ateapi.ActorState_ACTOR_STATE_RESUMING {
       // A RESUMING Actor is left to its resume, ...
       return nil
   }
   ```
   The only path that releases it is the deletion of the worker pod (`workflow_worker_delete.go:225`
   `crashBoundActor(… "Releasing actor from a worker whose pod is gone" …)`, with a RESUMING case at `:249`). That is
   exactly the release seen in the logs.
6. The re-call never comes for kagent sessions. The client got a 503 for its first message. Scope's retry sends a
   fresh `SendMessage` with no `contextId` (substrate-scope `server.mjs` `chatWithAgent` → `kg.send(ns, name, prompt,
   { messageId, signal })`). kagent's `PrepareSend` → `resolveSend` creates a new session and actor before it routes
   (`go/core/internal/service/session/interactions.go:143-151`). The stranded session is never addressed again.
   [PROVEN for Scope. INFERRED for other clients: I did not check whether kagent's 503 body carries the
   server-assigned contextId, which a client would need to retry into the same session.]
   A side effect: every pool-full retry leaves an orphan session and actor. This is the "sessions ~1000" seen earlier.

### 5.3 Not verified

- **Whether a sandbox process keeps running on the worker after the cancel.** [NOT VERIFIED] atelet logs show the
  cancel reached the worker's `RestoreWorkload`, after 68 to 410 ms of `worker_restore`. The ghosts' worker pods
  were deleted, and their logs went with them, before they could be read. The slot is held in any case, by the
  **booking in the store** (step 2), whether or not a process exists. This is proven from
  `SystemService/ListSubstrateWorkers`, where the slot shows `actor=…, state Resuming`.
- **Whether sending one more message to the ghost session (same contextId) heals it.** [INFERRED from
  `workflow_resume.go:242-248`] Not tested. In this run, the autoscaler had already crashed the ghosts before a test
  was possible, and the chat budget did not allow a second surge.

## 6. Which repo it belongs to, and suggested fixes

| Priority | Repo | Defect | Suggested fix |
|---|---|---|---|
| **Primary** | **agentgateway/agentgateway** (`crates/agentgateway/src/http/substrate/ingress.rs`, v1.7.0) | The park budget cancels an in-flight `ResumeActor`. This breaks the documented parking contract and strands actors | Use the budget only to decide whether to *start* a new attempt. Do not wrap the in-flight call in `tokio::time::timeout(remaining, …)`. Run the resume flight as a detached task (`tokio::spawn`) so that dropping the request does not cancel it, with an overall ceiling such as `RESUME_TIMEOUT`, or send a `grpc-timeout` so ateapi enforces its own deadline. When the attempt that was in flight at budget end succeeds, serve the request late, as the Go router does. Also return the real last error (Canceled/DeadlineExceeded), not the cached `ResourceExhausted` |
| **Distribution** | **kagent-dev/substrate** (Helm chart `charts/substrate`) | Ships agentgateway as the only router while the docs describe the Go router's never-cancel guarantee | Pin an agentgateway release with the fix, or make the Envoy + Go router selectable. Until then, add a release note. A larger `atenetRouter.requestParking.budget` lowers how often budgets run out. It does not close the race |
| **Defense in depth** | **agent-substrate/substrate** (ateapi; the fork has the same code) | A RESUMING actor whose caller is gone has no owner. It stays bound until its worker pod dies | Choose one: (a) after `BindActorToWorker` succeeds, run Restore and finalize under `context.WithoutCancel(ctx)` with a server-side timeout, because the work is committed; or (b) when `ctx.Err() != nil` in `handleAteletError`, roll back on a fresh context: Terminate the sandbox, release the assignment, set the state back to SUSPENDED (the snapshot is unchanged); or (c) add a sweep that re-drives `ResumeActor` (or rolls back) for RESUMING actors whose lease is free and whose state has not changed in N seconds. `workflow_reconcile_assignments.go:176` is where that skip lives today |
| Minor | kagent-dev/kagent | A first message that fails at routing still creates a session and actor, and the client cannot easily retry into it | Return the server-assigned `contextId` in the 503 error data, or delete or reuse the session when the first dispatch is not accepted (`ErrSendNotAccepted` path) |
| Ours (fixed) | themsquared/substrate-scope | SURGE retries created a new session on every attempt | Fixed: one `CreateSession` per logical chat, every retry sent with that `contextId` (`converse()` in `scope/lib/kagent.mjs`). Ghosts went from 3 of 13 SURGE chats to 0 of 26 |

## 7. Operator workaround

- **RESET POOL** in Scope (`POST /reset {"pool":"kagent-default"}`), or directly:
  ```bash
  kubectl --context kind-substrate-day -n kagent rollout restart deploy/kagent-default   # the Deployment is named <pool> on 1.0
  kubectl --context kind-substrate-day -n kagent rollout status  deploy/kagent-default --timeout=90s
  ```
  [PROVEN] When the old worker pod goes away, ateapi releases each ghost ("worker whose pod is gone"), crashes it,
  and frees the slot (01:46:26Z re-walk, 01:56Z cleanup). Suspended actors are snapshots and are not affected.
  The ghost actors end in **CRASHED**. That is harmless for SURGE sessions, which are thrown away. A real session
  would need a revert before it can be used again.
- A Scope AUTOSCALE walk-down also clears ghosts, but only if the ReplicaSet removes the pod the ghost is on (seen at
  01:55:12Z). Do not rely on it.
- Mitigation, not a fix: a larger park budget (`atenetRouter.requestParking.budget` in the substrate chart values.
  The key was checked in `charts/substrate/values.yaml:146-148` and the template `:113`) means fewer budgets run out
  during a surge, so fewer ghosts. This is not applied to the rig and not tested.
- Stage plan for the talk: after each SURGE beat, if a `Resuming` chip does not move within about 10 s, press RESET
  POOL before the next beat.
