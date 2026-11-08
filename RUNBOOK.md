# Demo runbook: kagent 1.0.0-rc3 + Substrate 1.0.0 (rig kind-substrate-day-ga, rebuilt Fri 2026-11-06)

Agent Substrate Day, Mon 2026-11-09. Live demo slot: deck slide 4 (2:00) to the money slide. The demo is **5:00 including the 60 s Telegram beat**. The 11-04 dress rehearsal fits it in 4:15 (section 3).
This file replaces `~/AgentSubstrate/DEMO-RUNBOOK.md` (that one is for kagent 0.10 / Substrate 0.0.9. Do not use it.)

Rig: kind cluster `kind-substrate-day-ga`, 18 Agents (13 on WorkerPool `kagent-default`, 5 on `kagent-oncall`).
Each pool runs 1 worker pod with limits 2 CPU / 2304Mi, which gives 2 actor slots (actors are booked at 1 CPU / 1Gi). At rest there are **2 worker pods**.
Model: Anthropic `claude-haiku-4-5`. This is a paid API, so every chat costs money.

Shorthand used below (paste it into every terminal you use):

```bash
k() { kubectl --context kind-substrate-day-ga "$@"; }
```

Tags: **[ran]** = I ran this read-only against kind-substrate-day-ga on 2026-11-04 and the output shown is real.
**[code]** = state-changing; I checked it against the code or flags, or ran it as a server dry run, but did not execute it.
**[UNVERIFIED]** = not checked. Rehearse it.

---

## 1. Preflight, morning of (about 10 min)

| # | Check | Command | Want |
|---|---|---|---|
| 1 | Docker VM not starved | `docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}'` [ran] | only `substrate-day-control-plane` (about 3.3 GiB) plus registries |
| 1b | Stop every other cluster | `docker ps --format '{{.Names}}' \| grep -vx substrate-day-control-plane` [ran], then `docker stop <those names>` | On 11-04 the `bb-mc-hq-*`, `bb-mc-uat-*` and `substrate-day-fresh-*` containers were running. `kind-registry` is **not** used by this cluster, so it is safe to stop. |
| 1c | kagent-ent stays OFF | `docker ps -a --filter name=kagent-ent --format '{{.Names}} {{.Status}}'` [ran] | `Exited`. Never start it (see section 5). |
| 2 | Cluster up | `k get --raw /readyz; echo; k get nodes` [ran] | `ok`, 1 node Ready |
| 2b | gVisor networking sysctl (lost if Docker restarts) | `docker exec substrate-day-control-plane sysctl net.ipv4.conf.all.proxy_arp` [ran] | `= 1`. If 0: `docker exec substrate-day-control-plane sysctl -q net.ipv4.conf.all.proxy_arp=1` [code: from install/up.sh] |
| 3 | 18 Agents Ready | `k get agents.api.kagent.dev -n kagent --no-headers \| wc -l` [ran] | `18`. Every row in `k get agents.api.kagent.dev -n kagent` shows `READY True`. |
| 4 | Pools at 1 pod each | `k get workerpools.ate.dev -n kagent` [ran] | `kagent-default 1 1 1` and `kagent-oncall 1 1 1`. If default is higher, run `k scale workerpools.ate.dev kagent-default -n kagent --replicas=1` [code: dry-run=server ok] |
| 5 | Full preflight (**1 billable turn**) | `cd ~/substrate-day-demo && KUBE_CONTEXT=kind-substrate-day-ga ./deploy/preflight.sh` [ran] | `preflight passed`, exit 0. On 11-04: 18 Agents Ready, 2 workers, metrics ok, k8s-tutor turn 742 ms. `SKIP_TURN=1` skips the turn. |
| 6 | Anthropic key (never printed) | see block A below [ran] | `cluster key == ~/.anthropic_key` and `200` |
| 7 | Telegram | see block B below [ran] | all ok |

**Block A: Anthropic key check.** This prints a match line and an HTTP code only. `/v1/models` is free.

```bash
a=$(k get secret kagent-anthropic -n kagent -o jsonpath='{.data.ANTHROPIC_API_KEY}' | base64 -d | shasum -a 256 | cut -c1-12)
b=$(tr -d '[:space:]' < ~/.anthropic_key | shasum -a 256 | cut -c1-12)
[ "$a" = "$b" ] && echo "cluster key == ~/.anthropic_key" || echo "MISMATCH"
printf 'header = "x-api-key: %s"\n' "$(k get secret kagent-anthropic -n kagent -o jsonpath='{.data.ANTHROPIC_API_KEY}' | base64 -d)" \
  | curl -sS -m 10 -o /dev/null -w '%{http_code}\n' -K - -H 'anthropic-version: 2023-06-01' https://api.anthropic.com/v1/models
```

**Block B: Telegram.** This block sends nothing to Telegram and changes nothing.

```bash
# tunnel connector holds edge connections (cloudflared metrics :2000 via a short port-forward)
(k port-forward -n kagent deploy/telegram-tunnel 22001:2000 >/dev/null 2>&1 & pf=$!; sleep 2; curl -s -m 3 http://127.0.0.1:22001/ready; echo; kill $pf)
#   want {"status":200,"readyConnections":4,...}  (any readyConnections >= 1 is ok)

# the doorbell answers from the internet, through Cloudflare
curl -sS -m 10 https://oncall-bot.mikemoore.ai/healthz; echo          # want: ok

# webhook the doorbell is serving + allowlist size (chat ids masked)
k logs -n kagent deploy/telegram-doorbell | grep '"listening"' | sed -E 's/[0-9]{6,}/<id>/g'
#   want "webhook":"https://oncall-bot.mikemoore.ai/telegram", "allowed":["<id>"]
k get configmap telegram-config -n kagent -o jsonpath='{.data.TELEGRAM_ALLOWED_CHATS}' | tr ',' '\n' | grep -c .   # want 1

# optional: Telegram's own view of the webhook (getWebhookInfo is read-only; the token goes through curl stdin)
printf 'url = "https://api.telegram.org/bot%s/getWebhookInfo"\n' "$(tr -d '[:space:]' < ~/.telegram_bot_token)" | curl -sS -m 10 -K - \
  | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")).result; console.log(r.url, "pending", r.pending_update_count, "last_error", r.last_error_message ?? "none")'
#   want https://oncall-bot.mikemoore.ai/telegram pending 0 last_error none

# no cloudflared on the Mac, ever
pgrep -fl cloudflared || echo "no cloudflared on the Mac"
```

On 11-04 all of block B passed: readyConnections 4, healthz ok, webhook URL correct, 1 chat allowlisted, pending 0, no last error.

**Telegram rehearsal.** Text the bot yourself from your phone (for example "is anything crashlooping?"). Watch the doorbell log **on the laptop only**, because the log shows your chat id:
`k logs -n kagent deploy/telegram-doorbell -f` shows `ring` → `session` → `done ... "sent":"ok"`, and no `undelivered`.
Do this **after** your last `reset-rehearsal.sh --yes`, because the script restarts the doorbell. After that, **do not restart the doorbell** before the talk. It keeps your chat's Session in memory, so the second turn takes about 3 s instead of about 9 s (measured 11-04).

---

## 2. Start the rig (T-15 min)

**Only one Scope per cluster.** First check whether one is already running:

```bash
lsof -nP -iTCP:8123 -sTCP:LISTEN          # [ran] a node process = Scope is already up; use it, do not start another
```

If nothing is listening, start Scope in terminal 1 and leave it visible on the laptop (not on the projector):

```bash
cd ~/substrate-day-demo/scope
KUBE_CONTEXT=kind-substrate-day-ga SCOPE_START_STOPPED=1 node server.mjs --live
# prints: Substrate Scope → http://127.0.0.1:8123 (LIVE, context kind-substrate-day-ga ...)
#         [scope] SCOPE_START_STOPPED=1: demo starts STOPPED — press START when ready
#         [scope] OK: kagent 1.0.0-rc3 · substrate 1.0.0 · 2 pool(s), 18 agents
```

[code + ran: the same command is running from ~/substrate-scope through the preview server. The scope/ copy matches that file for file.]

Open **http://127.0.0.1:8123** in the browser. Present at 1440x900 or larger. Telemetry is **below the fold** at 1440x900, so you will scroll to it.
Check the board: green `LIVE` badge, `18 AGENTS`, `2 WORKER PODS`, header button `DEMO STOPPED — START`, `AUTOSCALE: OFF`, `VIEW: AGENTS` (the URL has no `?group=session`).

**Before you walk up:** press `DEMO STOPPED — START`. The button changes to `STOP DEMO`. SURGE, TALK TO IT and stimulate send nothing while the demo is stopped.

**Stimulate (optional).** It gives background motion for the first 2 minutes. Start it in terminal 2 when you switch to the browser:

```bash
cd ~/substrate-day-demo/scope
node stimulate.mjs --budget 12 --concurrency 1 --oversub 0
```

[code] This makes about 12 chats, one at a time (about 1 minute), then stops by itself, before SURGE. **Always pass `--concurrency`.** Without it, stimulate sets its concurrency from the pool's slot count every 10 s. When AUTOSCALE adds pods, stimulate adds load, and the pool never walks back down.

**Do NOT run on show day:** `install/up.sh` (it re-runs `kagent install`), `deploy/telegram-up.sh` (it rolls the doorbell and loses your Session; `--register` calls setWebhook), any `helm upgrade` or `kagent install`, `stimulate.mjs` without `--budget`, a second `server.mjs --live`, or `cloudflared`.

---

## 3. The beats (talk order, 5:00 including Telegram)

Times are offsets from switching to the demo at slide 4 (2:00). The plan below uses **4:15 of 5:00**, so 45 s is spare for questions or a slow reply.
The long pole is the pool walk-down: SURGE to `1 pod` took **71 s** [ran]. Telegram fills that time. **The money chart goes last, after the pool is back to 1 pod.**

**Dress rehearsal, 2026-11-04 18:11 PT** [ran, from a clean reset]: two SURGEs, the stopwatch log, a 1 Hz `/status` timeline, and a DOM sampler. Telegram was skipped and given 60 s.
Measured: TALK TO IT reply 1.1 s. Session continuation reply 0.9 s, and the agent remembered the first turn. SURGE: 13 chats made **exactly 13 Sessions**, with no extra Sessions from retries. The lane drained by itself in **25 s** on 1 pod. AUTOSCALE pressed 6 s after SURGE: 4 pods 3.6 s later, lane empty 10 s after the press, back to 1 pod 65 s after the press. **0 ghosts in 26 SURGE chats.** Chats used: 40 (12 stimulate + 2 TALK TO IT + 2 × 13 SURGE).

| T+ | Beat | Length | What has to happen |
|---|---|---|---|
| 0:00 | 1. kubectl is lying | 0:25 | two commands, one line |
| 0:25 | 2a. Board + TALK TO IT (AGENTS view) | 0:40 | reply about 1 s |
| 1:05 | 2b. VIEW: SESSIONS, continue the session | 0:25 | reply about 1 s, it remembers |
| 1:30 | flip back to VIEW: AGENTS | 0:05 | optional (SURGE works in either view); AGENTS reads better on a projector |
| 1:35 | 3. SURGE (AUTOSCALE OFF) | 0:08 | lane fills in 2 to 3 s |
| 1:43 | 4. AUTOSCALE ON | 0:12 | press it **6 to 10 s after SURGE** |
| 1:55 | 5. Telegram (walk-down runs by itself) | 1:00 | pool reaches 1 pod at about 2:46 |
| 2:55 | 6. Ghost 👻 + RESET POOL | 0:25 | see the two cases below |
| 3:20 | 7. Money chart | 0:45 | only at `2 WORKER PODS` |
| 4:05 | AUTOSCALE OFF, STOP DEMO, back to slides | 0:10 | |
| 4:15 | spare | 0:45 | |

**Cuts if you run long** (in this order): drop beat 2b (saves 0:30). Drop the MEMORY tab in beat 7 (0:10). Drop stimulate (no time saved, but beat 2a is simpler, see below). Do not cut the 71 s walk-down: if it is not finished, keep talking or press `−` on the kagent-default row.

### Beat 1: kubectl is lying (T+0:00 to 0:25), terminal

```bash
k get pods -n kagent -l ate.dev/worker-pool
k get agents.api.kagent.dev -n kagent --no-headers | wc -l        # 18
```
[ran 18:11] Both commands return in under 0.1 s and print exactly two worker pods (`kagent-default-…`, `kagent-oncall-…`) and `18`.
Say: "Two quiet pods. Eighteen agents. Right now those pods hold zero of them. All eighteen are zstd snapshots in object storage."
(Do not use plain `get pods -n kagent`. It also lists the controller, UI, postgres, tools and telegram pods.)

Optional, at the same time, in terminal 2: `cd ~/substrate-day-demo/scope && node stimulate.mjs --budget 12 --concurrency 1 --oversub 0`.
[ran] It sent 12 chats, one at a time, and printed `budget reached` **58 s** after it started, so it is done well before SURGE. Each chat makes its own Session (12).

### Beat 2a: the board + TALK TO IT, AGENTS view (T+0:25 to 1:05), browser

- Walk the screen top to bottom. **Worker pools**: 2 rows, `1 pod × 2 slots`. **Restore queue**: empty. **Object storage**: 18 cards, `N snapshots · zst`. Header: `18 AGENTS · 2 WORKER PODS · 9.0× DENSITY`. `SESSIONS` is 0 after a reset and grows by 1 for every chat.
- Click the **k8s-tutor** card on the shelf. The drawer opens on the right. (With stimulate running it may already show a `PROMPT · STIMULATOR` / `REPLY` pair. Haiku replies take 1 to 7 s, so you will rarely catch a chip while it is RUNNING. Do not wait for one.)
- **TALK TO IT**: type in the box `Talk to this agent — wakes its actor`: "In one sentence: what is a gVisor sandbox?" and press SEND (or Return).
  [ran 18:12:20] The chip flies from the shelf to slot 1 of `kagent-default`, and the drawer gets `PROMPT · YOU`, then `RESTORE … → kagent-default-… (slot 1)`, then `REPLY · 1.1 s · YOU`, then `CHECKPOINT zstd snapshot → object storage`. Then the chip goes back to the shelf. Stimulate holds its own chats while yours is in flight.
- Say: "Restore from a snapshot, answer, checkpoint, gone. About a second."

### Beat 2b: VIEW: SESSIONS (T+1:05 to 1:30)

- Press **VIEW: AGENTS**. It changes to `VIEW: SESSIONS` in place (no reload; the URL gets `?group=session` as a deep link). The feed, counters and fairness are kept, and an open agent drawer moves to that agent's newest session. Sessions you started from TALK TO IT carry a green `you` marker, and the drawer header shows the session id and a source pill (`FROM YOU`, `STIMULATOR`, `SURGE`, `TELEGRAM`, `KAGENT-UI`).
- Now each chip is one conversation, labelled `agent ·<6 hex>`. **Without stimulate**, k8s-tutor has one chip, and it is yours. **With stimulate**, it has two (for example `·a56d89` and `·5d33e5`). Open the one with the `you` marker: the drawer title is `k8s-tutor · session <id>` with a `FROM YOU` pill.
- In the box `Continue this session — wakes its actor`, type "In five words: what did I just ask you?" and press Return.
  [ran 18:13:26] `REPLY · 0.9 s · YOU`: "You asked what gVisor sandbox is." The header `SESSIONS` count did **not** go up (13 before, 13 after).
- Say: "Same Session, a different actor restore, and it still remembers. The conversation lives in the snapshot, not in a pod."
- Close the drawer and press **VIEW: SESSIONS** to go back to `VIEW: AGENTS` (in place, instant). SURGE works in either view since the 11-04 evening fix (verified: 13 session chips filled the lane), but AGENTS view has fewer chips and reads better from the back of the room.

### Beat 3: SURGE (T+1:35 to 1:43). AUTOSCALE is still OFF.

- Check that stimulate has finished, if you ran it (terminal 2 shows `budget reached`).
- Press **SURGE** **once**. It sends 13 real chats, one to every Ready agent on `kagent-default`.
- [ran 18:13:48 and 18:15:04] Within 2 to 3 s, both bays show `2 busy (FULL)` and **10 to 11 chips** land in the **Restore queue** lane, marked `QUEUED · parked in router`. Some change to `client retry`. Header readouts: `parked in atenet-router 11`, then `router gave up` climbs to 12 to 15 and `scheduler no_capacity` to 230 to 280, as deltas `since SURGE hh:mm`.
- **On 1.0 the park budget is 60 s** (rc2 rig: 5 s). So on this rig the chips stay `QUEUED · parked in router`; none flip to `client retry`, and `router gave up` stays 0 while `scheduler no_capacity` climbs (GA rehearsal 11-06: `parked in atenet-router 11`, no_capacity 109 at +3.5 s). Say while the lane is full: "New since my first rig, the router *parks* a pool-full request instead of failing it: sixty seconds on 1.0, five on the rc2 I built on. no_capacity is a metric now, not a log line. And nobody picks who goes first."
- **Do not wait longer than about 10 s.** On 1 pod the lane drains by itself (rc2: ~25 s; GA with AUTOSCALE pressed at +7 s: empty 14.8 s after SURGE, pool 1 → 5 → 1, scale-up 1.6 s after the press, walk-down 46.6 s after). If AUTOSCALE is pressed after the lane is empty, nothing scales.

### Beat 4: AUTOSCALE (T+1:43 to 1:55)

- While the lane is still full, press **AUTOSCALE: OFF**. It changes to `AUTOSCALE: ON` and the feed logs `autoscale ON — kagent-default now follows demand`.
- [ran 18:15:10, 6 s after SURGE] **3.6 s later**: feed `autoscale kagent-default → 4 pods (demand 7 (5 waiting) ÷ 2 slots/pod)`. Header `5 WORKER PODS`, density `3.6×`. The row reads `4 pods × 2 slots`, with 2 bays `warming · joining the pool` for a moment. The lane is empty **10 s** after the press, and the last reply lands at about 15 s.
  The jump size depends on how long you wait: target = ceil((busy + waiting) / 2). At 6 s it was 4 pods. Pressed at about 2 s it would be up to 7 [code-derived].
- Say: "Busy plus waiting, one jump. CPU would have slept through this, because LLM turns are I/O wait."
- Walk-down: do not touch anything. [ran] **One step**: `autoscale kagent-default → 1 pods (peak demand 0 over 30s ÷ 2 slots/pod)` at 18:16:04, 50 s after the jump. The WorkerPool shows 1/1 at about 18:16:15. That is **65 s from the AUTOSCALE press and 71 s from SURGE**. The floor is 1 pod (`SCOPE_AUTOSCALE_MIN`, default 1).
  The pool row's `ready` lags behind: the WorkerPool showed `1/4` ready for about 10 s while 6 actors were already Running on the new pods. Do not read that out.

### Beat 5: Telegram (T+1:55 to 2:55), while the default pool walks down

Not rehearsed on 11-04 (no Telegram messages were allowed). Budget 60 s. Measured earlier on 11-04: restore about 0.3 s, first turn of a new Session about 9 s, follow-up about 3 s. `reset-rehearsal.sh --yes` restarts the doorbell, so the first text after a reset starts a new Session (about 9 s). Send your morning rehearsal text (section 1) after the last reset, and the on-stage text is a follow-up (about 3 s).

- Hold up the phone and text the bot: "is anything crashlooping?"
- Path: phone → Telegram → Cloudflare tunnel (in-cluster connector) → doorbell → A2A `SendMessage` → **sre-oncall restores on `kagent-oncall`** (the second pool row, which the surge does not touch). The agent calls its telegram `send_typing` tool, so the phone shows "typing…", then it reads the cluster with read-only tools and replies with `send_message`.
- On the board: the sre-oncall chip moves to a `kagent-oncall` bay. The feed and drawer show `📱 <your name>: ...` and then `📱 sent: ...` (chat ids are never shown on the board).
- Say: "The bot token is not in the sandbox. Egress injects it on the way out (RemoteMCPServer headersFrom). And the on-call tools run as a ServiceAccount bound to `view`: they cannot read Secrets."
  [ran earlier: `k auth can-i get secrets -n kagent --as=system:serviceaccount:kagent:oncall-tools` → `no`; telegram-mcp logs `"x-telegram-bot-token":"injected","len":46`]
- If the reply has not come by T+2:55, say "the phone is the least reliable component in this talk" and move on. The reply lands on the board when it lands.

### Beat 6: ghost 👻 + RESET POOL (T+2:55 to 3:20)

First look at the `kagent-default` row and the feed. There are two cases.

**A. A ghost is on the board.** A chip stuck Resuming on a bay for 20 s or more gets a 👻 badge and a dashed red outline, and its meta line reads `👻 stuck Resuming Ns`. The pool row adds `· 👻 1 ghost`. The feed logs `👻 <agent> stuck Resuming for Ns — RESET POOL frees it`. Fairness does not count ghost time as work.
- Point at it. Say: "That actor is holding a slot and doing nothing. A request that runs out its park budget strands the restore halfway, and nobody comes back for it. On rc2's five-second budget I got three per surge; 1.0's sixty makes it rare, not gone." (Scope now says `⏳ slow restore` at 20 s and only calls it a 👻 past the budget + 15 s, so a cold image pull is not mistaken for a ghost.)
- Press **RESET POOL**. It bounces `kagent-default` plus every pool that holds a ghost. The feed logs `frees N ghost(s)`, then `👻 <agent> ghost cleared by RESET POOL — it held a slot for Ns`. [code + fake feed only: no real ghost appeared on 11-04 after the one-session-per-chat fix]
- If the walk-down deletes the ghost's pod first, the feed logs `👻 <agent> ghost left Resuming — it held a slot …` and the badge is gone before you reach it. Then use case B.

**B. No ghost** (what happened in both 11-04 SURGEs: 0 ghosts in 26 chats. Before the one-session-per-chat fix, 3 of 13 SURGE chats became ghosts.)
- Say: "On the rc2 rig a request that timed out of its five-second park left a ghost: an actor stuck Resuming, holding a slot; upstream tracks it as #2059. Same router image on 1.0, sixty-second budget, and Scope retries into the same Session now, so we did not get one today. The fix, when you do, is one button."
- Press **RESET POOL** at rest. The feed logs one line (`reset rollout restart kagent-default …`, plus the ghosts it frees, if any). The pod name on the bays changes within about 2 s. **There is no `NO WORKERS` banner** (verified 11-04 19:00: health stayed ok for 20 s through the restart; the health check now counts workers ateapi reports ACTIVE, not the lagging WorkerPool status). The CPU caption blips to `reserved 750m` for a moment, then goes back to 500m. Say: "New pod, same eighteen snapshots."

### Beat 7: the money chart (T+3:20 to 4:05). Only after the default row shows `1 pod`.

- Check: header `2 WORKER PODS`. If the pool is still above 1 pod, keep talking, or press the `−` on the kagent-default row.
- Scroll down to **Telemetry** (below the fold at 1440x900). The **CPU** tab is selected. [ran 18:16:55] The caption reads `reserved 500m vs always-on 1800m (3.6×) · using 5m`. The amber solid line is reserved by worker pods (2 × 250m requests). The dotted line is the same 18 agents as always-on pods (18 × 100m, kagent 0.10.5 default requests). The shaded area is actual use.
- Click **MEMORY**: `reserved 1024Mi vs always-on 6912Mi (6.8×) · using 47Mi` [ran].
- The surge shows as a step on the amber line. With the 4-pod jump it peaked at 5 pods × 250m = **1250m, still under the 1800m dotted line**. Only a jump to 7 or more default pods (pressing AUTOSCALE within about 2 s of SURGE, or a second SURGE) crosses it.
- Say: "3.6 times less CPU reserved, 6.8 times less memory. The reservation breathes. It went up for the surge and came back down. Compare reservations, not usage."
- Press **AUTOSCALE: ON** to turn it OFF. Press **STOP DEMO**. Scroll back to the top. Switch to slides (slide 10, the money slide).

Optional, if you are ahead: the **Fairness** tab shows, per agent, time with the pool (amber) vs time waiting (pink). On 11-04 after one SURGE: slo-auditor `0% · waited 13s · 1 sess · starved`. It covers only what this page saw since it loaded, so a VIEW flip or a reload empties it.

Lessons from the abstract that the slides cover, not the board: actors list vs workers (slide 19), CPU/memory are the wrong signals (slide 6), autoscaler made it worse on a serial backend (slide 25), ghost actors / RESET POOL (slide 22), usage charts lie (slide 13).

---

## 4. If something wedges

**Rule: one recovery attempt, then put up the backup slide and narrate. Do not debug on stage.**

| Symptom | Action |
|---|---|
| Any billable chat running away | **STOP DEMO** (stimulate halts within about 0.5 s; parked chats are aborted). Ctrl-C in terminal 2. [code] |
| Bays look idle, lane full, nothing schedules, or a 👻 chip (ghost actor) | **RESET POOL** = `k rollout restart deploy/kagent-default -n kagent`, plus the same for every pool that holds a 👻 ghost. Snapshots survive. [ran 11-04 at rest: new pod in about 2 s, no `NO WORKERS` banner; the ghost-pool bounce is code only] By hand for on-call: `k rollout restart deploy/kagent-oncall -n kagent`. |
| Docker Desktop restarted (every container `Exited (137)`, `kubectl` cannot connect) | `docker start substrate-day-ga-control-plane`, wait for `kubectl --context kind-substrate-day-ga get --raw /readyz` to print `ok`, give pods ~60 s (they come back on their own: 18/18 Ready, tunnel re-connects, no re-register needed), then restart Scope. Seen 11-08 07:27: ~2 min to fully healthy. |
| Pool stuck at N pods / `NO WORKERS` / DESIRED ≠ READY | `k get workerpools.ate.dev -n kagent; k get pods -n kagent -l ate.dev/worker-pool`, then `k scale workerpools.ate.dev kagent-default -n kagent --replicas=1` [code: dry-run ok] (or the header `−`/`+`, which is clamped to 1 to 8). With AUTOSCALE ON, a pool below 1 is scaled back up automatically. |
| Board frozen, badge `DISCONNECTED` / `STALE` | Scope restart: Ctrl-C in terminal 1, then run the same start command from section 2. Within 30 min it restores STOP DEMO / AUTOSCALE from `$TMPDIR/substrate-scope-8123.json`. With `SCOPE_START_STOPPED=1` it always comes back **stopped**, so press START. If the lead's preview server owns port 8123, restart it from there instead (do not start a second one). [code] |
| Red banner `controller unreachable`, short | Do nothing for about 5 s. Scope's port-forwards respawn every 2 s on the same local port, and stimulate picks up the new address. [code] |
| Controller really broken | `k rollout restart deploy/kagent-controller -n kagent && k rollout status deploy/kagent-controller -n kagent` (about 30 s), and the forwards self-heal. [code] |
| Replies are errors mentioning `x-api-key` / `401` | Key rotation. Save the new key to `~/.anthropic_key`, then run block C below. [code: dry-run=server ok] |
| Bot silent | Laptop only: `k logs -n kagent deploy/telegram-doorbell --tail=20`. **No `ring`** = delivery problem: check healthz + `/ready` (block B), then `k rollout restart deploy/telegram-tunnel -n kagent`. **`ignored`** = allowlist. **`undelivered`** = the agent did not send, so retry the text once. Doorbell itself down: `k rollout restart deploy/telegram-doorbell -n kagent` (new Session, first reply about 9 s). If it is still silent after one retry: "the phone is the least reliable component in this talk", then move on. Never start cloudflared on the Mac. Never run `--register`. |
| Cluster gone / Docker dead | **Zero-cluster fallback**: `cd ~/substrate-day-demo/scope && PORT=8124 node server.mjs` (simulated, touches no cluster; [ran]: starts and serves), open http://127.0.0.1:8124. Or put up **deck slide 8** (file slide12, "BACKUP ONLY") and narrate the beats from it. **As of 2026-11-04 that slide is BLANK in `unpacked/` and in `r-08.jpg`: put a board screenshot on it before Monday.** |

**Block C: Anthropic key rotation** (the key never reaches argv or the screen):

```bash
k create secret generic kagent-anthropic -n kagent --from-file=ANTHROPIC_API_KEY=/dev/stdin --dry-run=client -o yaml \
  < <(tr -d '[:space:]' < ~/.anthropic_key) | k apply -f -
k rollout restart deploy/k8s-credential-provider deploy/atenet-egress -n ate-system
k rollout status deploy/k8s-credential-provider -n ate-system; k rollout status deploy/atenet-egress -n ate-system
# then block A, and one turn: KUBE_CONTEXT=kind-substrate-day-ga ./deploy/preflight.sh
```
(The two ate-system restarts are the procedure the lead verified on 11-04. Their `restartedAt` annotations are 15:52. I did not re-run them.)

---

## 5. Do not touch (during or right before the talk)

- **No `helm upgrade`, `kagent install`, `install/up.sh`.** `kubectl scale` owns `WorkerPool.spec.replicas`. A Helm upgrade would fight it and reset the worker sizing.
- **Never run `cloudflared` on the Mac.** A second connector splits the tunnel and some deliveries return 502. The only connector is `deploy/telegram-tunnel` in the cluster.
- **Never start `kagent-ent-control-plane`** (the stopped kind-kagent-ent cluster). Its own tunnel connector would come up and split Telegram traffic.
- **Only one Scope per cluster.** Check `lsof -nP -iTCP:8123 -sTCP:LISTEN` before you start one. (A simulated `node server.mjs` without `--live` touches no cluster, so it is fine on another port.)
- No `deploy/telegram-up.sh` (it rolls the doorbell and loses your Session) and no `--register` / setWebhook. The webhook is pinned (`WEBHOOK_IP` set) and working.
- Never `k get secret ... -o yaml` on the projector. The `kagent-anthropic` Secret carries a `last-applied-configuration` annotation that contains the key.
- Doorbell / telegram-mcp logs contain your chat id: laptop only, never projected.
- Always use `--context kind-substrate-day-ga` (the `k` function). Other kube contexts exist on this Mac.

---

## Reset between rehearsals

Every chat (stimulate, SURGE, TALK TO IT, Telegram, the preflight turn) creates a Session and leaves a Suspended actor. Clean them between rehearsals. Scope's ListSessions reads at most 10 pages of 100: above 1000 Sessions the newest drop off, and the board misses turns.

1. Press **STOP DEMO**. Set **AUTOSCALE** to OFF (with it ON, Scope owns the pool size and can scale again after the reset). Ctrl-C any stimulate.
2. Dry run (the default; changes nothing):
   ```bash
   cd ~/substrate-day-demo && KUBE_CONTEXT=kind-substrate-day-ga ./deploy/reset-rehearsal.sh
   ```
   It prints the before counts, the Sessions it would delete (by agent), and any it skips.
3. Act:
   ```bash
   KUBE_CONTEXT=kind-substrate-day-ga ./deploy/reset-rehearsal.sh --yes
   ```
   It does these steps:
   - It deletes every Session of an Agent in `kagent` with `SessionService/DeleteSession` (the RPC that `kagent agent session delete ID` calls). The call is sent as each Session's creator. **This also deletes the Session's Substrate actor.**
   - It skips a Session that has lifecycle work pending, and a Session whose actor is on a worker (Resuming, Running, Suspending, Reverting). A ghost actor stuck in Resuming is one of these. The fix for a ghost is **RESET POOL**. Then run the script again.
   - It deletes orphan actors (`session-<uuid>`, Suspended or Crashed, no live Session) only with the rc2 `kubectl-ate` (`KUBECTL_ATE=path`). The plugin in `~/go/bin` is the old one (`unknown service ateapi.Control`). If orphans exist and no rc2 plugin is found, the script prints FAIL and the build command.
   - It scales every WorkerPool in `kagent` to 1 and waits for 1/1.
   - If it deleted Sessions, it restarts `deploy/telegram-doorbell`. The doorbell keeps its chat to Session map in memory. A deleted contextId gets `task not found`, and the doorbell then retries once on a new Session. The restart clears the map, so the first Telegram message after the reset starts a new Session directly. The restart does not call `/register` or setWebhook.
   - It prints the after counts and checks that all Agents are Ready.
   - It never touches ActorTemplates, golden snapshots, tags, Agents, other namespaces, or other contexts. A second run finds nothing to delete (idempotent). Exit code 0 means everything is ok.
   - Options: `--no-doorbell-restart`, `--keep-pools`, `--concurrency N` (default 4).
4. Check: the board header shows `18 AGENTS · 2 WORKER PODS · 0–1 SESSIONS`. The shelf still lists all 18 agents, because their golden snapshots are kept. Optional, one billable turn: `KUBE_CONTEXT=kind-substrate-day-ga ./deploy/preflight.sh`.
5. **On show morning, restart Scope after the last reset** (not just a reload): Scope keeps its activity log in memory, so a reloaded page still replays drawer entries from the chats the reset deleted, timestamped before the demo. Between rehearsals a reload is enough. The script deletes every session at once, and an open page logs a burst of false `ran + checkpointed between samples` lines for it. A VIEW flip does not clear anything. Router and scheduler deltas reset on page load, START and each SURGE.
6. Leave Scope at `VIEW: AGENTS`, `AUTOSCALE: OFF`, `DEMO STOPPED`.

[ran 11-04 17:56 PT] Before: 1017 Sessions, 1017 actors (1008 Suspended, 9 Crashed), pools 1/1 + 1/1. The script deleted 1017 Sessions in 22 s, all actors went with them, and there were 0 orphans. After: 0 Sessions, 0 actors, 18/18 Agents Ready, doorbell restarted. A second `--yes` run deleted nothing. One k8s-tutor chat afterwards completed in 1.3 s and gave 1 Session and 1 actor. The board showed 18 agents and 1 session.

[ran 11-04 18:17 PT, after the dress rehearsal] 39 Sessions (12 stimulate + 1 TALK TO IT + 2 × 13 SURGE; the session continuation added none) deleted in 3.2 s, 0 orphans, pools 1/1 + 1/1, doorbell restarted, 18/18 Agents Ready. Board: 0 sessions, demo STOPPED, autoscale OFF.

**Slide 19 quotes "282 after one afternoon".** After a reset the live number is near 0. If you want a real number to point at, run one rehearsal after the reset (it adds about 25 to 30), or say that the number was reset this morning.
