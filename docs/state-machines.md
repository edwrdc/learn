# App state machines

This reference describes the app changes built on commit
`11333815e2e0810f6f110700222329e9aae96651`. Explicit unions coexist with implicit
states represented by maps, flags, transcript predicates, and ordered writes.
Historical failures are marked before-fix. Integrated fixes and open confirmed
issues have separate status tables. Final integrated checks passed in the
coordinator's sandbox, as recorded below. This document does not claim exhaustive
app coverage.

## Evidence and scope

| Evidence label | Meaning |
| --- | --- |
| Code-traced | The implementation contains the described state or transition. This is not a runtime measurement. |
| Existing assertion | A repository test asserts the behavior. Tests were read, not run for this document. |
| Reported reproduction | The coordinating investigation reports a runtime reproduction. The documentation pass did not rerun it. |
| Hypothesis | The interaction needs a controlled reproduction before it becomes a confirmed bug. |

Coverage includes foreground runtime ownership, turn admission and settlement,
chat client state, questions, jobs and steers, durable background roles,
extraction, compaction, persistence, settings, desktop startup, the standalone
server, artifact dispatch, and selected UI state.
This is not an exhaustive inventory of components or asynchronous interleavings.

## Desktop and standalone server lifetime

### Process roles and shell boot

[electron/main.cjs](../electron/main.cjs) chooses the browser helper role before
the ordinary shell takes a single-instance lock or redirects development data.
The shell and application server are separate processes.

| State | Event or guard | Transition and invariant |
| --- | --- | --- |
| Role undecided | `--browser-service` present | Enter helper startup. Do not take the shell lock or use the development data redirect. |
| Shell selected | `LH_DEV_URL` present | Use the separate `userData` path with suffix `-dev` before taking the lock. |
| Shell selected | Lock unavailable | Quit. An existing instance restores and focuses its first window on `second-instance`. |
| Lock owned | App ready, development URL present | Use that URL without spawning a server. |
| Lock owned | App ready, no development URL | Choose a free port and spawn the packaged server under `ELECTRON_RUN_AS_NODE=1`, bound to `127.0.0.1`. Pass data and auth paths, not file key contents. |
| Server spawned | HTTP poll receives any response | Create the hidden app window. Show it on `ready-to-show`. This poll does not require a successful HTTP status or prove application readiness. |
| Server spawned | Connection errors exhaust poll retries | Reject startup without an app window. The ready callback has no startup-error cleanup. No automatic child restart is implemented. Each HTTP attempt has no explicit request timeout. |
| Server running | Child exits | Log exit and clear `serverProcess`. This alone does not close an existing window. |
| Window closed | Last window closes | Quit outside macOS. On macOS, remain resident. Activation recreates a missing window using the same URL. |
| Shell leaving | `before-quit`, process exit, or `SIGHUP` | Clear the owned child reference, send `SIGTERM`, and schedule `SIGKILL` after three seconds. A process-exit callback does not guarantee that its timer executes. |

Reported real-Electron reproduction left the unchanged production main process
alive without a window after 33 seconds. A second launch exited without starting
a server because the first process retained the lock. Missing entry and working
directory cases also left no window. A server that accepts but never answers an
HTTP request can keep the readiness wait pending. This startup issue is open,
not fixed. The reproduction used an isolated profile, not a normal user install.

### Browser helper and page ownership

[headless.ts](../src/jobs/headless.ts) owns helper discovery and
connection. [browser-service-readiness.cjs](../electron/browser-service-readiness.cjs)
supplies the helper readiness wait. Executable presence is only an availability
hint, not proof that a browser can start.

| State | Event or guard | Transition and invariant |
| --- | --- | --- |
| Helper startup | No connected parent IPC | Refuse startup and exit with code 1. |
| Helper startup | Parent IPC connected | Register disconnect handling, choose a debugging port before app readiness, load a hidden blank window, and wait for the debugging endpoint. |
| Helper ready | Readiness succeeds without lifetime abort | Print `BROWSER_SERVICE_CDP <port>`. The caller accepts only ports 1 through 65535. |
| Helper starting or ready | Parent IPC disconnects | Abort readiness and quit. Startup errors unrelated to disconnect exit with code 1. |
| Caller has no reusable port | Binary resolves | Spawn with IPC after removing `ELECTRON_RUN_AS_NODE` and `LH_DEV_URL`. Wait up to 15 seconds for the handshake. Timeout kills the child. |
| Caller has a port | Endpoint supplies a debugger URL | Connect to the helper. A live child with a stored port can be reused. |
| Helper unavailable | No binary, missing handshake, or endpoint connection fails | Try per-job system Chrome. Close that browser in `finally`. A failure inside an already-selected helper page job does not switch to Chrome. |
| Helper connected | Page job begins | Queue work through `withHelperPage` (a `keyedLock`) because the helper has one page target. Completion attempts navigation to `about:blank`. A failed job does not block the next queued job. |

Only page work is serialized. Connection and helper startup occur before the
page queue. Concurrent cold startup and complete listener cleanup between jobs
were not verified. Blank navigation is not evidence that Node-side page
listeners were removed. PDFs render natively. SVGs try native rendering first
and use the browser only if that attempt fails.

### Standalone build and start

[build-server.mjs](../scripts/build-server.mjs),
[start-server.mjs](../scripts/start-server.mjs), and
[server-launch.mjs](../scripts/server-launch.mjs) own different stages.

| State | Event or guard | Transition and invariant |
| --- | --- | --- |
| Existing generated payload | Root `data` or `auth.json` present | Throw before rebuilding or removing the payload. User data must not be treated as generated output. |
| Build admitted | Adapter `handler.js` missing | Refuse, remove the generated payload, and exit with code 1. |
| Build admitted | Adapter output present | Replace the generated payload. Copy server output, prompt assets, launcher, and the installed runtime dependency closure, preserving nested package paths. |
| Payload copied | Explicit verification fails | Remove the payload and exit with code 1. Checks reject data directories, secret files, checkout sources, missing imports, and missing native packages. Arbitrary filesystem exceptions are not an atomic rollback. |
| Payload verified | Build finishes | Return the payload path. This checks files and dependency presence, not server execution. |
| Source-run start | Start script executes | Load production environment files, fill absent data and auth paths with repository paths, rebuild the payload, then import its server entry. A build failure prevents this import. |
| Packaged start | Launcher executes directly | Skip source-run dotenv and rebuild. Set protocol, body-size, and prompt-root environment values before importing the handler. |
| Handler loaded | HTTP server starts | Stamp each request protocol as HTTP and listen on the configured host and port. Default host is loopback. A non-loopback host logs a warning because requests have no authentication. |

The launcher has no application-level graceful-shutdown state machine. Shell
signal escalation is separate from durable recovery on the next process start.
The build is also not a safe replacement of an existing payload. Reported
reproduction served HTTP 200 from a curated payload, then removed adapter
`handler.js`. Source startup failed and deleted the old payload through `fail`.
Restarting that payload then failed with `MODULE_NOT_FOUND`. User data was not
deleted in this reproduction. This generated-output loss is open, not fixed.

## Runtime ownership and foreground turns

### Runtime slots

[src/session/durable.ts](../src/session/durable.ts) owns `RuntimeSlot`,
`openChatRuntime`, and `closeChatRuntime`. Its process-global map owns one
database handle per chat. Absence from the map is an implicit state.

| State | Event | Next state and effect |
| --- | --- | --- |
| Absent | First open | `opening`. Store the shared open promise. |
| `opening` | Another open | Join that promise. |
| `opening` | Bootstrap succeeds | `open`. Restore extensions and model bindings before `harness.resume()`. |
| `opening` | Open or bootstrap fails | Absent. A bootstrap failure closes the Harness and throws `ChatRuntimeInitError`. |
| `opening` or `open` | Close | `closing`. Drain the open and app append queue, then close the Harness. |
| `closing` | Open | Refuse new work. |
| `closing` | Another close | Join the close promise. |
| `closing` | Close finishes | Absent. A later open may create a new runtime. |

The ownership invariant applies within one process, not across processes.
Closing is not deletion. `removeChatRuntimeFiles` removes the directory after
close, without a tombstone. Server admission and deletion now share the
process-local operation queue described below. Existing assertions in
[tests/durable-store.test.ts](../tests/durable-store.test.ts) cover shared opens,
refusal while closing, and reopening. They do not
establish that arbitrary retained runtime references are safe after deletion.

### Admission, execution, and settlement

No single boolean describes foreground state.

| State component | Owner | Meaning |
| --- | --- | --- |
| Request claim | `beginTurn` and `endTurn` in [turn-liveness.ts](../src/session/turn-liveness.ts) | Process-local admission and settlement exclusion, with a 30-minute stale-claim limit. |
| Committed run | `LiveDoc.run`, read by `isCommittedRunLive` | A durable conversation has a run. Reads inspect an already-opening or open runtime. |
| Finish descriptor | `ForegroundTurn` and `TurnDoc` in [turn-service.ts](../src/session/turn-service.ts) | Turn and request identities, safe model snapshot, phase, entry boundary, and `running`, `settling`, or `settled` mark. |
| Server handle | [turn-runs.ts](../src/session/turn-runs.ts) | Memory-only handle for stream attachment and remote abort. |
| Local settlement | `turnSettles` in [turn.ts](../src/session/turn.ts) | Shared promise per chat and turn prevents concurrent local finishers. |

`isTurnRunning` includes an unexpired claim and a committed run. Settlement
therefore remains busy after generation ends. `isCommittedRunLive` excludes a
claim-only settlement window, so a steer cannot start an unmanaged run there.

| Logical state | Trigger or guard | Transition and invariant |
| --- | --- | --- |
| Unadmitted | Missing chat, model, provider key, or engine | Refuse before generation. Configuration refusals return machine-readable 503 responses. |
| Queued | `withChatOperation` | Wait for the preceding same-chat admission or deletion. Read existence inside the queue. Different chats remain independent. |
| Waiting for compaction | `ensureCompacted` | Wait before preparing model-facing input. The operation queue excludes deletion, though admission has not claimed the chat yet. |
| Input validation | Invalid answer or other invalid input | Return 400. An answer must name a pending question. |
| Question pause | `continue` or `steers` with an unanswered question | Continue returns a settled terminal without generation. Steers return 409 for retry. |
| Parallel question answer | Another question remains pending | Replace this answer placeholder and notify. Start no run. |
| Claim acquired | `beginTurn` succeeds | Write an answer edit or preceding appends. A competing claim returns 409. |
| Descriptor written | `writeTurn` | Store recovery state before submission. A descriptor alone does not prove admission. |
| Admitted | `root.submit` commits with `whenBusy: "reject"` | Submit the last model-facing input with `turn:<turnId>`. Register the handle and announce `turn-started`. POST returns an acknowledgment, not the turn stream. |
| Claim acquired, no handle handoff | Admission exits or throws | Release the owned claim in `finally`, including failed write-ahead and entry reads. |
| Running | Run finishes, fails, or aborts | Enter common settlement. |
| `running` or `settling` descriptor | `claimTurnSettle` | Set `settling` unless already settled or superseded. A later process may replay interrupted settlement. |
| Settling | Finish services run | Append usage, reconcile steers, append plan blocks, trigger eligible extraction, and apply parked dismissal. Then mark `settled`. |
| Finish attempt ends | Lifecycle release | Release claim and handle, announce `turn-settled`, repump steers, and optionally kick compaction. |

Code-traced limits matter. Some finish services catch and log their own errors.
A `settled` mark does not prove that every external write succeeded. An outer
settlement failure leaves `settling` for recovery but still releases local
liveness and announces `turn-settled`.

The [operation queue](../src/session/chat-operations.ts) covers admission,
including compaction and cheap sibling-answer writes, but not generation.
Deletion can wait behind compaction, then refuse the admitted turn with 409.
Queue failures do not block later operations. The lock order is operation queue
before store queues. Same-chat recursive queue entry is unsupported.

`resumeForegroundTurn` checks `submissionByRequest` before recovery. Without a
committed submission, a descriptor left by failed admission is not settled.
For an active run or queued submission, recovery restores the captured model
and phase before scheduling. An unavailable captured model fails the open
closed in those cases. Recovery also applies unfinished app settlement for a
run that already finished, without resolving its captured model. Recovery
looks up the submission before claiming and releases only a claim it acquired
if handoff fails.

Existing assertions in
[tests/durable-foreground-recovery.test.ts](../tests/durable-foreground-recovery.test.ts)
cover mid-generation recovery, settlement once, and a failed reopen followed by
model restoration. [tests/turn-liveness.test.ts](../tests/turn-liveness.test.ts)
covers claim rejection and lifecycle announcements.

### Conversation phase and learner pauses

`chatPhase` in [phases.ts](../src/session/model/phases.ts) derives
`practice` from chat kind. Otherwise, `hasProbeDone` selects `teach` instead of
`probe`. A recovered turn uses its stored admission phase.

| State | Event | Result |
| --- | --- | --- |
| Generating | Valid question tool round completes | `questionStopHook` terminates generation and parks inputs. |
| Generating | Question validation fails | Permit another generation round to repair the call. |
| Question pending | Answer | `answerWrite` replaces the committed placeholder with a context edit. A legacy record without a placeholder appends the result. |
| Question pending | Dismissal | Write the dismissal without starting a run. |
| Turn busy | Dismissal arrives | [dismissal-park.ts](../src/session/dismissal-park.ts) stores one process-local intent per chat. Last write wins. |
| Dismissal parked | Settlement validates it | Apply it against the settled record. Drop `ChatInputError` if its target no longer exists. Retain intent on other write failures. |
| Dismissal at transcript tail | Background result awaits delivery | Hold the idle wake until the learner sends again. |

Parked dismissal intent does not survive process death. This is a code-traced
boundary, not a newly approved persistence change.

### Dismissal, steer, and abort API states

| API | State or guard | Response and transition |
| --- | --- | --- |
| [Dismiss](../src/routes/api/chats/[id]/dismiss/+server.ts) | Unknown chat or invalid dismissal | Return 404 or 400 respectively. |
| Dismiss | Turn busy | Return 202 after parking the parsed intent. Target validation waits until settlement. This route does not itself abort the turn. |
| Dismiss | Turn idle | Validate and write the dismissal, then return 200 without generation. Activity-touch failure is logged and does not undo the dismissal. |
| [Steer](../src/routes/api/chats/[id]/steer/+server.ts) | Unknown chat, invalid parsed input, or no committed live run | Return 404, 400, or 409 respectively. A 409 permits the client fallback to ordinary send. Malformed JSON is not caught as a `ChatInputError` in this route. |
| Steer | Live inbox accepts input | Return 200. Acceptance does not mean the marker has already entered the transcript. Delivery and reconciliation remain separate states. |
| [Abort](../src/routes/api/activity/abort/+server.ts) | Invalid JSON, kind, or ID | Return 400 before domain cancellation. |
| Abort job | Job absent or terminal | Return 404 or 409. An accepted abort returns 200. |
| Abort turn | No registered handle | Return 409 even if other liveness state remains. A registered handle receives abort and returns 200 without waiting for completion. |
| Abort extraction | Any state | Request cancellation and return 200. Absence of work is success. |

[turn-runs.ts](../src/session/turn-runs.ts) returns a `turn-settled` wire event
and `[DONE]` when a stream has no handle. An acknowledgment, a cancellation
request, and a settled durable record are different observations.

### Durable turn wire and subscriber lifetime

[durable-turn.ts](../src/session/pi/durable-turn.ts) projects committed entries,
live generation, and tool slots into the wire protocol. The replay log is
memory-only. The durable conversation remains authoritative.

| State | Event or guard | Transition and invariant |
| --- | --- | --- |
| Watching, not started | Live run, generation, or assistant entry appears | Emit `agent_start` once. A committed instant answer still emits start and update before message end. |
| Assistant partial active | Changed full partial snapshot | Emit a start or update for the same assistant slot. Do not represent text chunks as separate messages. |
| Tool slot running | First observation or changed output | Emit one execution start per call ID and latest output updates. A committed result emits execution end. |
| Tool round awaiting results | All named call results commit | Emit `turn_end` with the collected round results. |
| Update pending | 100 ms flush timer or non-update event | Fan out the latest update per message or tool call. Replay replaces an in-flight update slot instead of storing every chunk. End events release that update slot. |
| View attaches | `subscribe()` | Replay the log, then receive new events. A settled handle also sends `[DONE]`. Cancellation removes only that subscriber. |
| Recovered view | `replayAfter` supplied | Begin entry replay after the stored entry ID, not after an unstable entry count. |
| Submission ends | Submission wait and conversation idle wait finish | Fetch final entries, await `onFinish`, emit `agent_end`, and close subscribers with `[DONE]`. The idle wait includes a follow-up run started by a queued steer. |
| Runtime closing | Watch or settlement observes close | Close subscribers without ordinary app settlement. Leave committed work for recovery. |
| Remote abort requested | Handle not settled | Set the local abort observation and request conversation abort. Log an abort-call failure. This request is not proof that cancellation finished. |
| Watch fails | Runtime not closing | Emit masked error and attempt settlement. Hypothesis: a rejection of `onFinish` can leave the shared settlement promise rejected before `agent_end` and stream closure. This failure path was not reproduced here. |

Non-assistant app entries keep their record IDs for upsert. Assistant wire
messages do not acquire app record IDs from this adapter. A stream attachment
is not the owner of generation or of durable admission.

### Tool replay policy and engine bindings

| Machine | State or event | Policy and invariant |
| --- | --- | --- |
| Tool registration | [adapter.ts](../src/tools/adapter.ts) adapts a tool | Tools marked `replaySafe` in the [tool catalog](../src/tools/model/catalog.ts) (`quiz`, `explain`, `probe`, `recall`, `ask_user_question`, `problem`, and `conclude`) receive replay policy `safe`. Every other name receives `unsafe`. Execution mode, argument preparation, abort signal, errors, termination, and usage pass through the adapter. |
| Engine registry | `bindRunEngine(sessionId, engine, observer)` in [engines.ts](../src/platform/engines.ts) | Insert or replace that session binding in a process-global map. No single current engine governs all conversations. |
| Bound request | Router receives a bound `options.sessionId` | Use the captured engine model and stream function. Forward both the upstream provider observer and the bound observer. |
| Unbound request | Missing or unbound session ID | Use the base model collection. Registry absence is not itself a setup refusal. |
| Model lookup | `getModel(provider, id)` | Prefer a matching bound model object. Request routing still selects the engine by session ID, not by whichever matching model lookup returned first. |
| Foreground lifetime | [durable-registry.ts](../src/session/durable-registry.ts) binds the chat ID | [durable.ts](../src/session/durable.ts) unbinds on failed bootstrap or runtime close. Ordinary turn settlement does not itself remove the binding. |
| Background lifetime | [jobs/runtime.ts](../src/jobs/runtime.ts) attaches a child | Bind its descriptor session ID. The attached runner uninstalls its extension and removes that binding in `finally`. Recovery restores required bindings before scheduling. |

These tables describe app registration policy, not dependency guarantees about
crash replay or external side-effect deduplication.

## Chat client and notification recovery

[SessionModel](../src/lib/chat/session-core.ts) owns the portable machine.
[SessionView](../src/lib/chat/session.svelte.ts) mirrors it into Svelte state.
Messages consist of server `base` plus local `tail`. Execution results and
streaming IDs are separate temporary state.

| Status | Entry | Exit |
| --- | --- | --- |
| `ready` | Construction, stream cleanup, or local `stop()` | Send or attachment sets `submitted`. |
| `submitted` | Optimistic input and POST, or stream attachment | First wire event that changes the view sets `streaming`. Request failure sets `error`. |
| `streaming` | A message or tool result changes the view | Cleanup normally sets `ready`. Attachment exception sets `error`. |
| `error` | Send or attach exception, or exhausted 409 wait | A new send sets `submitted`. Question and problem dismissals may send silently. `clearError()` clears only the message. `stop()` resets status. |

The error banner is independent of status. A provider error wire event can set
the banner while stream cleanup returns to `ready`. `readyRef` follows
`status === "ready"`. Sends and dismissals also accept `error`, but still refuse
`submitted` and `streaming`.

| Operation | State contract |
| --- | --- |
| `send` | Add optimistic input, POST one event, drain the acknowledgment, then attach through the stream endpoint. The initial POST deliberately does not use the view abort controller. |
| `postInputEvent` | After 409, cancel the response body, delay, poll jobs, and repost the same body when `turnInFlight` is false. Check cancellation after the delay and jobs poll. Defaults use 500 ms polling and a 30-second accumulated delay budget. Network wait time is additional. An already-started input POST has no view abort signal. |
| `resumeStream` | Abort the previous consume and replay onto a clean tail. Default attachment fetches the record first. A fresh mount may skip that fetch. |
| `applyWireEvent` | Replace full assistant partials in one local slot. Upsert identified non-assistant messages. Do not append each text update as a new message. |
| `stop` | Detach locally and clear execution state, but retain the partial tail. This alone does not stop server generation. |
| Detached or replaced consume | Ignore stale request errors, stream events, settle hooks, and cleanup. A successful input acknowledgment still drains after detach, without attaching an obsolete view. |
| Silent dismissal | Append optimistic dismissal and POST without a view abort signal. Report current failures. Ignore delayed failures after a newer send or reattachment advances the turn generation. `stop()` alone does not advance that generation. |
| `abortInFlightTurn` in `ChatPage` | Detach locally and request remote abort through `/api/activity/abort`. |
| `setMessages` | Replace the record and clear the tail. This is an idle synchronization operation. |
| `adoptRecord` | Accept an append-only record and retain unabsorbed local messages. Reject adoption if a previous base message disappeared. |
| `steer` | Queue an indicator and submit to the live inbox. A 409 drops the indicator and falls back to text send. |

[ServerEventHub](../src/lib/state/server-events.ts) has stopped and started
states. `start` opens one `EventSource` per window. Every open, including
reconnect, invokes resync callbacks. Notifications are not a durable event log.

[ChatPage.svelte](../src/lib/chat/ChatPage.svelte) combines local stream status with
`ChatSync` in [chat-sync.svelte.ts](../src/lib/chat/chat-sync.svelte.ts), which holds
`turnInFlight` handling, the owed sync, job status history, and `compacting`. Job completion
adopts the record during a live turn and requests a full sync when idle.
Mount and reconnect refresh jobs and fetch the authoritative `compacting` flag
without replacing messages. `ChatSync`'s compaction revision rejects an older status read
after a newer read or matching `compaction-changed` frame. A failed refresh
leaves the current flag unchanged.

Existing assertions in [tests/session-core.test.ts](../tests/session-core.test.ts)
cover byte-identical retries, failed-send recovery, stop during the delay or
jobs request, stale response bodies, replacement stream cleanup, execution
replay, and unabortable acknowledgment drain. Dismissal cases cover recovery
from attachment error, busy gates, stale errors after send or reattach, and
current errors even after stop. The
[compaction browser regression](../tests/browser/frontend-suite-compaction.mjs)
drops status frames, invokes resync during and after a summary, and asserts
that the optimistic transcript survives. These assertions were read, not run
in this documentation pass.

## Jobs, steers, and durable background roles

### Job records and steer delivery

`JobStatus` is `running`, `done`, or `error` in
[jobs/model/types.ts](../src/jobs/model/types.ts). Running includes result
delivery, not just model execution. Executable behavior in
[jobs/wake.ts](../src/jobs/wake.ts) takes precedence over older protocol
comments that describe finalization only after the whole wake turn completes.

| Logical state | Event | Effect |
| --- | --- | --- |
| Dispatched | Job tool creates a record | Return an acknowledgment immediately. Start a background runner without ending the teacher turn. |
| Running loop | Role returns a result or failure-shaped result | Store result and activity `delivering result`. Keep status `running`. |
| Result queued | Committed foreground run is live | Submit an eligible marker to its durable inbox. Mark queue entry `submitted`. |
| Result queued | No committed run is live | Wait for no busy turn and no pending question. Wait 750 ms and recheck. |
| Idle wake eligible | Transcript ends in dismissal | Keep markers pending without starting a wake. |
| Idle wake eligible | Gates stay open | Remove carried entries before firing one wake with all missing markers. |
| Wake returns 409 | Client turn won admission | Requeue and retry after 500, 1000, 2000, then 5000 ms. |
| Marker visible or reconciled | Entry commits, settlement finds it, or idle wake returns 200 | Resolve delivery and finalize a still-running job from its result. |
| Submitted marker missing at settlement | Run stopped before consuming it | Clear `submitted` and repump through the gates. |
| Permanent delivery failure | Another wake status or no runner | Reject delivery and mark a still-running job `error`. |
| Learner aborts | `abortJob` | Record terminal error before cancellation. Stop the loop or recovered child, drop unsubmitted result markers, and queue an abort marker. |

The delivery registry and one-pump-per-chat set are process-local.
`submitSteer` checks `LiveDoc.run` and creates the inbox submission in one
transaction. The request ID is the steer ID. A `probe-handoff` never enters a
live run because it must start the teacher phase in a fresh turn.
Already-submitted markers cannot be recalled by filtering the local queue.
Ordinary finalization does not overwrite terminal job status.

`recoverStaleJobs` runs once at boot (`boot()` crash recovery in
[src/boot.ts](../src/boot.ts), skipped when `upkeep` is off). It skips terminal jobs, live abort registrations, missing chats, and
busy chats. Orphans with results are redelivered. Orphans without results are
respawned. The transcript supplies delivery deduplication.

[tests/jobs.test.ts](../tests/jobs.test.ts) contains assertions for question and
dismissal pauses, 409 backoff, duplicate delivery, abort during delivery, and
orphan recovery. This pass did not verify every overlap between those paths.

### Durable child conversations

[jobs/runtime.ts](../src/jobs/runtime.ts) stores an index in
`BackgroundRunsDoc`. `BackgroundRunDoc` stores model identity, prompt, cap, and
role state. Seven kinds (`BackgroundKind`) are defined in
[durable-run.ts](../src/jobs/durable-run.ts).

| Index state | Event | Transition |
| --- | --- | --- |
| Absent | `ensureRun` | Commit a child conversation, descriptor, and `running` index entry together. |
| `running` or `done` | Same job identity reattaches | Reuse conversation and request ID. Resolve the captured model instead of silently adopting another model. |
| `failed` or stale entry | Next attempt | Remove index entry and create a new child attempt. |
| `running` | Successful completion | Store `done` and return persisted role state. |
| `running` | Failure or abort | Store `failed`. Runtime close instead preserves recoverability rather than delivering an ordinary failure. |
| Indexed | Caller retires consumed run | Remove index entry. This does not claim physical removal of child history. |
| `running` after restart | Bootstrap | Restore tools and engine before scheduling. Honor terminal job records as cancellation intent. An unavailable engine fails the open closed. |

An in-flight promise map coalesces attachments by chat and job within its module
instance. Durable request identity handles reattachment across restarts.

| Role | Persisted progress or verification state |
| --- | --- |
| `research` | Fetched URLs. |
| `demo` | HTML, last tested HTML, and verification result. A changed artifact differs from its tested version. |
| `visual` | Current SVG, rendered SVG, pending render, and render error. An unrendered final artifact prompts a render and image continuation unless capped. |
| `pdf` | Consulted pages, read pages, pending renders, and cap-blocked unread state. An unread brief receives a nudge or fails at the cap. |
| `extract` and `audit` | Validated `submitted` object committed into role state. |
| `compact` | Durable conversation output without separate artifact-verification state. |

Existing assertions in
[tests/durable-background-roles.test.ts](../tests/durable-background-roles.test.ts)
cover role restart, submit persistence, caps, distinct concurrent engines, and
compaction conversation reuse. They do not prove dependency scheduler internals.

## Extraction and compaction

### Extraction phases and coverage

[pipeline.ts](../src/graph/extraction/pipeline.ts) owns source single-flight
state, early cancellation controllers, and visible per-batch rows. A second
request for an in-flight source returns zero counts instead of joining its result.

| Phase or state | Transition | Invariant or limit |
| --- | --- | --- |
| Admitted but not visible | Read source and compute uncovered batches | Early controller accepts cancellation before the first visible phase. |
| `queued` | Wait for an extraction slot | Extractor calls share a three-slot limit. |
| `extracting` | Produce source-local findings | Batches of one source run in order and read its updated digest. Different sources can extract concurrently. |
| `waiting` | Wait for audit lock | Intended audit and merge exclusion is process-wide. Wait and handoff check cancellation. |
| `auditing` | Read graph and validate identity decisions | Critical section includes audit and subsequent merge. |
| `merging` | Recheck chat existence, merge findings, write coverage, and settle layout | Session anchors must name teacher prose in the current batch. |
| Batch complete or failed | Clean registry and persist usage | Successful earlier batches stay covered. Ordinary batch failure permits later batches. |
| Source aborted | Cancel current work and stop later batches | Unmerged work remains uncovered. Earlier successful merges remain. |
| Source complete | Release early and single-flight state | Later requests can retry uncovered work. |

Coverage in [graph/coverage.ts](../src/graph/coverage.ts) uses message fingerprints.
Changed extractable content becomes uncovered again. Merge and coverage writes
are synchronous app operations, not one crash-atomic transaction across files.
Notes imports share this pipeline and graph writer but use source records and
need no session message anchors. Detailed notes retry state was not inventoried.

Existing assertions in [tests/extraction.test.ts](../tests/extraction.test.ts)
cover single-flight across instances, cleanup, cancellation, partial usage,
audit ordering, an aborted waiter, isolated batch failures, and anchors.
An assertion about one aborted waiter does not prove arbitrary multi-waiter
cancellation schedules.

### Compaction gate

[session/compaction.ts](../src/session/compaction.ts) tracks an in-flight promise
per chat. `kickCompaction` starts after settlement. `ensureCompacted` waits for
existing work and checks whether another summary is needed before the next turn.

| State | Event | Result |
| --- | --- | --- |
| Idle | Below effective threshold | No summary. |
| Idle | Above threshold | Register work and read current record. |
| Cold gate reads record | Another cold gate or settlement kick registers work during the read | After the read, join the competing promise before the missing-record and below-threshold exits. A persisted marker can reduce the projection below threshold before usage persistence finishes. |
| Registered | Cut cannot advance beyond previous kept boundary | Skip repeated summary. |
| Summarizing | Valid cut exists | Announce `running: true`. Summarize prior summary plus newly dropped messages. |
| Cut selection | A question remains pending | Keep its calling assistant and the entire following tail, even over budget. Tool results also retain their calls. |
| Summarizing | Nonempty summary | Pass only `[marker]` to `saveMessages`, with the first kept message ID. Append usage and announce `record-changed`. Do not resubmit the pre-summary transcript snapshot. |
| Summarizing | Empty output or summarizer failure | Append no summary marker. A later gate may retry. |
| Finishing | Inner summary exits | Announce `running: false`. Outer completion releases the in-flight promise. |

The effective threshold is the smaller of the setting and model window minus
reserve, with the window-derived value at least one. Unknown windows use the
setting. The marker changes provider context projection, not export history.
Failure after marker persistence can leave the marker committed even if usage
persistence fails. The catch does not roll back committed work.
Marker-only persistence preserves concurrent answer edits and appends. Pending
question retention keeps a dismissal during summary visible in provider context.
The cut guard can leave an oversized retained tail above threshold rather than
repeatedly summarize a span whose boundary cannot advance.

Existing assertions in `tests/compaction.test.ts` cover parallel pending calls,
legacy calls, and oversized tails. `tests/compaction-dismissal.test.ts` covers
dismissal during cold admission and idle kicks, reopen, summary failure and retry,
and graded answers in provider input. These fixes do not remove an obsolete
summary marker that remains inside the kept tail. That separate issue is open.

The existing summary catch logs ordinary summarizer failures and returns
without a marker. The turn-start gate can then proceed without reducing
context. The competing-promise fix does not change that policy. Failures
outside the inner catch can still reject the gate.

The registry and visible status event cover different intervals. Dependency
construction and preliminary reads precede the inner summary event.
[tests/compaction-service.test.ts](../tests/compaction-service.test.ts) asserts
one concurrent summary, waiting, chained summaries, threshold resolution, and
retry after a summarizer exception. New parameterized assertions hold the gate
while either a cold gate or kick starts during `getChat`. Admission-versus-delete
ordering is covered separately in
[chat-operations.test.ts](../tests/chat-operations.test.ts).

## Persistence, graph state, and deletion

### Chat metadata and transcript

[session/store.ts](../src/session/store.ts) serializes metadata operations per chat.
JSON stores metadata. Durable entries store messages and context edits.

| State | Event | Result |
| --- | --- | --- |
| No record | Read | Return null at the record boundary. |
| Legacy JSON has messages | Read | (Legacy import removed.) `readRecord` drops a `messages` field from the metadata; the transcript comes only from durable entries. |
| Current metadata | Mutation | Reread under queue and rewrite once. Turn usage deduplicates by turn ID. Extraction usage deduplicates by start identity. |
| Newer schema version | Access | Refuse rather than rewrite with an older build. |
| Deleting | Store deletion | Hold metadata queue, close runtime, remove directory, then unlink metadata. |
| Deletion fails | Runtime removal or metadata unlink throws | Propagate filesystem removal errors. `closeChatRuntime` logs and swallows Harness close errors, so deletion continues after those errors. Return false only when neither metadata nor runtime existed. Earlier removals are not rolled back. |

Metadata and runtime append queues protect different operations. The server
operation queue now orders admission against server deletion before either
entrypoint reads existence. It does not protect direct low-level callers or
other processes. Close can still invalidate arbitrary retained references.

Four JSON replacement writers were confirmed to truncate the destination in place:
`writeMeta` (now in `src/session/store.ts`), `writeSettings` (now
`src/settings/store.ts`), `writeSourceMap` (now `src/graph/store.ts`), and
`writeRenderSettings` (removed; render settings now live in `settings.json`
`graphRender`). In current code the three remaining writers call
`writeJsonAtomic` ([platform/fs.ts](../src/platform/fs.ts), temporary file and
rename). The findings below describe the code as it was when traced.
Reported fault injection after truncation left each file at zero bytes. Settings
read as null, sources as an empty list, render settings as null, and chat lookup
as missing. The durable SQLite transcript survived the metadata failure.
Retries do not reliably recover old data. A section retry lost sibling settings,
and reimport restored only one source without its previous usage history.
Existing temporary-file-and-rename graph and auth writers retained their old
bytes under the same injection. This comparison does not prove power-loss
durability. Private-file replacement was approved for the four writers; the
current `writeJsonAtomic` calls pass no owner-only mode.

### Graph ledgers and session deletion

[graph/store.ts](../src/graph/store.ts) appends shaped JSONL records and skips
malformed lines on read. [graph/snapshot.ts](../src/graph/snapshot.ts) (`getGraph`) derives nodes and
chains from those records. Later lines add aliases and provenance to existing
identities. Format stamps refuse incompatible newer graph formats.

| Deletion stage | Guard or effect |
| --- | --- |
| Existence check | Missing session returns 404. |
| Busy checks | Foreground turn or running job returns 409. |
| Extraction wind-down | Abort session extraction and wait for its visible rows to leave. A 10-second timeout returns retryable 503. |
| Graph purge | `deleteChatTraces` synchronously rewrites affected ledgers. |
| Job purge | Remove session jobs. |
| Chat removal | Await store deletion and runtime close. This stage is asynchronous despite the older orchestration comment describing a synchronous block. |
| Chat removal fails | A false result or exception returns HTTP 500 with code `delete_failed` and message `Session deletion failed. Try again.`. Internal details stay in the server log. Graph and job purges may already have completed. |

[graph/model/deletion.ts](../src/graph/model/deletion.ts) defines two explicit modes.
`preserve-graph` removes coverage and checkpoints but keeps nodes and chains.
`delete-nodes` removes session provenance, nodes without surviving references,
affected chains, and dead positions. Shared node identity survives even when
the deleted session originally named it.

Synchronous rewrites prevent JavaScript interleaving inside that block. They do
not provide a transaction across graph files, jobs, metadata, and SQLite.
Multi-process writers and process death between writes remain outside the
demonstrated exclusion guarantee.

### Single-node and partial selection deletion

`deleteGraphNode` in [graph/service.ts](../src/graph/service.ts) and
[deleteNodeTraces](../src/graph/model/deletion.ts) implement node deletion.
This operation does not use session deletion's provenance-preservation policy.

| State | Event or guard | Transition and invariant |
| --- | --- | --- |
| Delete requested | Any visible extraction status exists | Return 409 `extraction_running` without aborting extraction. This gate runs before node existence lookup. No foreground-turn or job gate applies. |
| Delete allowed | ID absent from its ledger | Return 404 `not_found`. |
| Argument selected | ID starts with `arg_` | Remove its chain lines and position. Keep member propositions. |
| Proposition selected | Node exists | Remove every line for that node, chains naming it as premise or conclusion, and positions for the node and removed chains. Return statistics and graph revision. |
| Ledger writes in progress | Synchronous execution | No JavaScript task interleaves between the gate and writes. Multiple file writes are not one crash-atomic transaction. |
| Dialog confirming | Confirm with a nonempty selection | [DeleteNodeDialog.svelte](../src/lib/home/DeleteNodeDialog.svelte) enters busy and sends sequential DELETE requests, collecting successful IDs. |
| Dialog busy | HTTP or network failure | Stop the loop and show failure. Already-deleted nodes remain deleted. If any succeeded, invoke `onDeleted` with that partial list. |
| Dialog busy | Every request succeeds | Invoke `onDeleted` with all successful IDs. The parent owns dismissal and graph refresh. |
| Partial success callback | Chain-table parent | [ChainTableOverlay.svelte](../src/lib/home/ChainTableOverlay.svelte) removes only successful IDs from the dialog and selection. Keep failed and unattempted nodes, preserve the failure, and retry only that remainder. |
| Success callback | Graph parent | [GraphView.svelte](../src/lib/home/GraphView.svelte) closes its single-node dialog and refreshes the graph. It does not supply a multi-node selection. |

The partial-deletion retry fix is integrated. Assertions in
`tests/browser/frontend-suite-deferred.mjs` cover HTTP and network partial
failures, remaining selection, graph revision, and retry without re-deletion.
The final integrated frontend browser suite passed, including these assertions.
Escape can currently invoke dialog close while busy. Closing the dialog does
not cancel requests already sent.

## Settings and selected UI state

### Settings and model resolution

[settings.ts](../src/settings/model/settings.ts) and [resolution.ts](../src/settings/model/resolution.ts) separate persisted overrides from
effective settings. Missing preference overrides select factory preferences.
Model selection has no fabricated fallback model. Conversation selection uses
the chat override over the strong slot. Background roles use the role override
over the assigned slot.

| State or operation | Transition |
| --- | --- |
| File absent or unparseable | [settings/store.ts](../src/settings/store.ts) returns null. Callers resolve defaults. |
| Object loaded | `sanitizeUserSettings` validates known sections independently and preserves actual unknown top-level keys. Malformed known sections cannot re-enter through unknown-key copying. |
| Section PUT | `parseSection` in [schema.ts](../src/settings/model/schema.ts) rejects invalid known values and drops unknown body fields. |
| Cross-validation | [section route](../src/routes/api/settings/[section]/+server.ts) checks catalog choices, clamps thinking levels, and removes orphaned enabled prompt switches. |
| Section write | Replace the entire selected section. Missing fields mean absent overrides, not a patch into old values. |
| UI write succeeds | [SettingsDialog.svelte](../src/lib/settings/SettingsDialog.svelte) adopts returned record and emits section notification. |
| Execution lacks model or key | Refuse the affected operation instead of choosing a different provider or model. |

Compaction sanitation is independent of graph presence and rejects arrays.
Known sections retain only their known fields. Unknown top-level keys survive,
but the retired `chat` and `general` sections are stripped (`RETIRED_SECTIONS`
in [schema.ts](../src/settings/model/schema.ts)).

Stale same-section replacements are a confirmed open issue. The reported real
route reproduction composed two `agent` bodies from the same record. Both PUTs
returned 200, but the second body removed the first tool toggle. Composing the
second body from the first returned record preserved both toggles. Concurrent
PUTs to different sections preserved all sections across 20 rounds. The
read-modify-write block has no `await`, so that reproduction refutes a
single-process cross-section server race. Browser timing remains unverified.
Existing suites include
[settings-store.test.ts](../tests/settings-store.test.ts),
[settings-body.test.ts](../tests/settings-body.test.ts),
[settings-resolution.test.ts](../tests/settings-resolution.test.ts), and
[settings-pure.test.ts](../tests/settings-pure.test.ts). Read assertions include
first boot, corrupt-file fallback, sanitizer round trip, malformed known
sections, rejected model and endpoint contents, graph-independent compaction,
unknown-key preservation on disk reads and writes, and removal of `chat`.
The sanitizer regressions are in [settings.test.ts](../tests/settings.test.ts).

### Setup and key ownership

[setup.ts](../src/lib/settings/setup.ts) derives `keys` or `pickers` from
provider-key presence. This is a setup-stage selector, not provider authentication.

| State | Event | Result |
| --- | --- | --- |
| Any setup stage | Provider list is null, empty, or has no present key | Select `keys`. |
| Any setup stage | At least one provider reports a present key | Select `pickers`. Presence does not prove that the provider accepts the key. |
| `pickers` | Resolve saved slot pins against the current catalog | Prefill matching provider and model pairs only. Missing models stay unselected. Resolve a supported thinking level. |
| Any key source | Invalid key shape on save | Reject before writing. No live provider validation occurs. |
| No real environment value | Save a valid key | Write the file, then reflect the value into the environment as an app-owned fill-gap value. |
| Real environment value present | Save a file value | Keep environment precedence. The status reports the shadowed file value. |
| File or app-owned environment value | Delete | Remove the file value and only the app-owned environment copy. A real environment value remains active. |

[settings/keys.ts](../src/settings/keys.ts) tracks real environment ownership and
fill-gap ownership. [settings/auth-store.ts](../src/settings/auth-store.ts) rereads the file on
access, treats absent or malformed content as an empty map, and uses a
mode-0600 temporary file and rename for writes. Write errors propagate.
With `LH_IGNORE_ENV_KEYS=1`, boot removes known environment keys and only file
values count. This explicit first-run simulation bypasses normal precedence.
[settings-pure.test.ts](../tests/settings-pure.test.ts) asserts stage selection.
[byok-refusal.test.ts](../tests/byok-refusal.test.ts) asserts prefill behavior.
[auth-keys.test.ts](../tests/auth-keys.test.ts) and
[auth-store.test.ts](../tests/auth-store.test.ts) cover key rules and storage.
The full setup dialog remains outside this trace.

### Custom endpoint save, discovery, and removal

[settings/custom-endpoint.ts](../src/settings/custom-endpoint.ts) owns one optional
endpoint and its key binding. Its GET state exposes configuration, key presence,
and key source, never the key value.

| State or operation | Guard or event | Transition and invariant |
| --- | --- | --- |
| Provider unsynced or stale | Endpoint or active key signature changes, or registration presence differs | Synchronize the process provider collection from persisted settings and the active key. Removing configuration removes the provider. |
| Save requested | Invalid configuration, key type, or key shape | Refuse before writing. Validation does not authenticate the key with the provider. |
| Fixed environment key owns endpoint | Pasted key or change to an already-stored base URL | Refuse. The environment key cannot be shadowed or silently rebound. Initial save can bind it without a pasted key. |
| File-owned key, same normalized base URL | No pasted key | Reuse the active key. A missing active key refuses the save. |
| File-owned key, new base URL | No pasted key | Refuse. Stored credentials do not carry to a new URL. |
| New URL and pasted key | Save proceeds | Write the new URL-derived key ID before settings. A settings failure leaves the prior configuration and key intact, but may leave the new unused key. |
| Same URL and pasted key | Save proceeds | Write settings before replacing the key. A settings failure leaves the existing key unchanged. A later key-write failure does not roll back settings. |
| Configuration saved | File-owned key | Prune other stored custom-endpoint keys, then return synchronized safe state. Prune failures are not a cross-file rollback. |
| Explicit model discovery | Typed key supplied, or stored URL matches | Use the typed key or that stored URL's active key. An environment-owned fixed key requires a saved matching URL and refuses a pasted key. |
| Discovery active | Endpoint responds or fails | Refuse redirects. Apply a timeout. Return normalized model rows on success, 400 for input or key-ownership refusal, and 502 for transport, HTTP, JSON, or model-list failure. Discovery does not save configuration. |
| Remove requested | Settings write succeeds | Remove configuration first, then prune stored custom-endpoint keys. Keep chats, graph, and saved model pins. Environment-owned keys remain environment-owned. |

Keys use a hash of the normalized base URL, not a shared key slot for every
endpoint. The code does not promise a transaction across settings and auth
files. The [endpoint route](../src/routes/api/custom-endpoint/+server.ts) maps
validation failures to 400. Filesystem exceptions propagate rather than becoming
successful saves. The [discovery route](../src/routes/api/custom-endpoint/models/+server.ts)
returns the discovery status without persisting model rows.

### Settings dialog pending operations

[SettingsDialog.svelte](../src/lib/settings/SettingsDialog.svelte) reads and writes
through the `settings` store in
[settings.svelte.ts](../src/lib/state/settings.svelte.ts), a `Resource`
([resource.svelte.ts](../src/lib/state/resource.svelte.ts)). Neither has a write
queue, pending-write counter, request-generation guard, or close-time
cancellation. Visibility and request lifetime are separate states.

| State | Event | Transition and limit |
| --- | --- | --- |
| Shown | Dialog opens | Call `settings.refresh()`. The dialog's `record` is `undefined` until the store's first load lands. A reopen does not first clear the previous record. |
| Load pending | Success or failure | Adopt the returned settings, or a version-only empty record on first boot. A failed load with no earlier value shows `record = null`; a failed reload keeps the last value. A late response has no visibility or generation check. |
| Record editable | Section changes | Clear the shared write error and call `settings.save(section, body)`. Other writes can overlap. |
| Write pending | Rejected request (HTTP or network) | Set a section-prefixed error. |
| Write pending | Successful response | Adopt the returned whole record in the store and emit the `settings-saved` page event for that section. |
| Any request pending | Dialog closes | Hide the dialog without aborting or awaiting that request. Late completion can still update the store and emit notifications. |

The absence of ordering guards and composition from the last adopted record are
code-traced. Same-section lost updates are route-reproduced as described above,
not browser-proven. A separate modeled reverse response adoption also lost a
setting on a later PUT. Actual reversed response arrival in the dialog remains
unverified.

### Artifact dispatch projection

[ArtifactPart.svelte](../src/lib/chat/ArtifactPart.svelte) and
[DispatchCard.svelte](../src/lib/artifacts/DispatchCard.svelte) project job state
(the former `JobCards.svelte` no longer exists).
They do not own durable job transitions.

| State | Input or event | Display or transition |
| --- | --- | --- |
| No matching job | Missing jobs prop or no matching `toolCallId` | Show the running card with `Dispatched…`. Missing data is not a terminal failure. |
| Job running | Matching job has `running` status | Show activity and elapsed value when present. Result delivery can still be in progress. |
| Job terminal | Model or provider-key refusal | Show setup action when chat actions exist. Refusal checks precede the generic failure display. |
| Job terminal | Other `error` or successful completion | Show failed or delivered respectively. |
| Demo or visual part | Artifact renderer dispatches | Forward jobs directly to `DispatchCard`. |
| Research or PDF part | Part reaches `output-available` | Forward jobs through `ArtifactPart` to `DispatchCard`. Updated job records can change activity, terminal status, and setup refusal display. |

Artifact job prop forwarding is integrated.
`tests/browser/frontend-suite-dispatch.mjs` contains assertions for recorded
jobs and refreshed lists through running, delivered, and setup-refusal states.
The final integrated frontend browser suite passed, including these assertions.
Other rich artifact rendering states were not traced.

### Practice progression

[practice.ts](../src/session/tools/practice.ts) shares one `PracticeGate` between
sequential `problem` and `conclude` tools. The lazy seed reads the transcript
once per toolset. Tool results update the local gate immediately.
[activeProblemOf](../src/session/model/transcript.ts) reconstructs persisted state
from successful acknowledgments, not from tool calls alone.

| State | Event | Result |
| --- | --- | --- |
| Unseeded gate | First tool execute | Share one seed promise and derive whether a problem is active. |
| No active problem | Valid `problem` with absent or known targets | Activate the gate and return the pose acknowledgment. The committed `modelSolution` supplies the later reveal. |
| Active problem | Another `problem` | Return invalid input. Keep the current problem. |
| No active problem | Unknown graph target | Refuse the pose without activating. Empty target lists normalize to absent targets. |
| Active problem | Thinking or answer messages | Keep the problem active until conclusion or dismissal. |
| Active problem | Successful `conclude` | Free the gate. Persist outcome metadata and reveal the solution from the pose. |
| No active problem | `conclude` | Return invalid input. |
| Persisted transcript | Errored or dangling pose or conclusion | Ignore that call when deriving active state. Only a clean acknowledgment changes the fold. |
| Active problem | `problem-dismissed` marker | Clear active state immediately. A later input synthesizes the dismissed conclusion pair. |

The tool description asks the agent to end after conclusion and await the
learner before another pose. The boolean gate alone does not enforce that
whole-turn policy, because a successful conclusion makes the slot available.
[practice-record.test.ts](../tests/practice-record.test.ts) asserts clean-result
activation, failed-call handling, and deferred dismissal.
[practice-flow.test.ts](../tests/practice-flow.test.ts) exercises the pose,
thinking, conclusion, reveal, and dismissal flow with a scripted engine.

### Graph interaction and layout settlement

[graph-canvas.ts](../src/lib/home/graph-canvas.ts) keeps pointer, simulation,
commit timer, camera, and animation state separately. These are implicit
states, not one exhaustive union.

| State | Event | Result |
| --- | --- | --- |
| At rest | Primary press on a node with a simulation | Capture the pointer if possible and pin the node. Do not reheat physics merely for a press. |
| Node pressed | Pointer moves beyond `CLICK_SLOP` | Cancel a pending commit, reheat the simulation, and pin the node to world-space pointer coordinates. |
| Node pressed | Primary release | Clear pointer ownership and unpin. An active simulation relaxes. Otherwise, invoke node selection. |
| Stage pressed | Release within click distance | Select the hit node or invoke the stage-click callback. Larger movement is a pan, not a click. |
| Simulation active, no drag | Alpha falls below `SIM_SETTLE_ALPHA` | Stop simulation work and schedule a debounced position commit. |
| Commit pending | Timer fires after 250 ms with moved data | Invoke `onCommit` with current positions. A new drag or `setData` cancels the pending commit. |
| Hover changes | Animation frames | Fade toward the new hover target. Clear the old glow node after fade-out. |
| Renderer active | Destroy | Cancel pending frame and commit work, stop the simulation, and remove event listeners. |

The renderer invokes callbacks. It does not make callback success equivalent
to durable position persistence. [graph-canvas.test.ts](../tests/graph-canvas.test.ts)
covers pure geometry helpers, not every DOM pointer schedule. Ledger identity
and deletion rules are described under persistence above.

### Dialogs, dictation, and navigation

These are selected local machines, not a complete UI inventory.

| Machine | States and transitions | Ownership and limits |
| --- | --- | --- |
| Settings dialog | Hidden or shown, section and optional row. Initial load uses `undefined`, failure uses null, success uses a record. Open selects a target. Close hides it. | [dialogs.svelte.ts](../src/lib/state/dialogs.svelte.ts) and [SettingsDialog.svelte](../src/lib/settings/SettingsDialog.svelte). Load and write errors are separate state. |
| Session deletion dialog | No selection, confirmation, busy, or failed with retry. Clearing selection resets options and failure. | [DeleteSessionDialog.svelte](../src/lib/shell/DeleteSessionDialog.svelte). Trace removal is unchecked by default. The request chooses an explicit mode. |
| Dictation | `idle`, `connecting`, `recording`, `stopping`. Start acquires microphone, worklet, and token. Socket open enters recording. Stop waits for final results or three-second cleanup timeout. | [dictation.svelte.ts](../src/lib/chat/dictation.svelte.ts). Generation counter rejects stale callbacks. One abnormal socket close can reconnect with a fresh token. |
| Dictation finish and cancel | Finish waits for cleanup and flushes buffered final text. Cancel clears the buffer first. Cleanup stops tracks, disconnects nodes, closes socket, resolves waiters, and returns idle. | Shared AudioContext and worklet promise are separate resource state. Hardware and navigation during capture were not exercised. |
| Warm dictation token | Absent, pending or cached promise, expired, or rejected. Concurrent calls share a promise. Expiry and refresh mint again. Failure clears cache. | `createWarmMinter` has assertions in [dictation-warm.test.ts](../tests/dictation-warm.test.ts). These do not exercise hardware or the service. |
| Message navigation | Invalid or absent hash, target missing, or target found. Later rendering can resolve a missing target. Matching hash and element suppress a repeated jump. | [navigation.ts](../src/session/model/navigation.ts), [session-nav.ts](../src/lib/chat/session-nav.ts), and `jumpToHash` in `ChatPage`. Jump stops automatic scroll and temporarily highlights the target. |

[tests/session-navigation.test.ts](../tests/session-navigation.test.ts) asserts
encoded IDs, malformed hashes, first provenance anchors, and distinct anchors
within grouped assistant content.
[tests/svelte-dialogs.test.ts](../tests/svelte-dialogs.test.ts) contains rendering
assertions for confirmation and deletion defaults. Rendering is not proof of
focus behavior or request ordering.

## Ranked confirmed issues and integrated fixes

The rows rank observed impact, not the order of discovery. P1 affects destructive
operation correctness or truthful deletion reporting. P2 blocks progress, permits
unwanted work, or lets invalid settings reach runtime policy. Every row has an
integrated fix and regression assertions. The final integrated checks below passed.
The reproduction column describes before-fix behavior, not the current contract.

| Rank and ID | Before-fix reachable failure | Integrated change and regression evidence | Status |
| --- | --- | --- | --- |
| 1. P1, SM-1. Admission and deletion | Reported reproduction paused admission at compaction, deleted the chat, then resumed admission. The request hit a closed runtime, leaked its claim, and recreated an empty durable directory. A failed post-claim entry read also escaped cleanup. | The shared operation queue orders both existence reads through admission or deletion. Claim cleanup covers failed admission and recovery handoff. [chat-operations.test.ts](../tests/chat-operations.test.ts) gates real compaction and runtime close, orders two deletions, rejects the uncovered entry read, and checks recovery lookup failure. | Integrated. Final integrated checks passed. |
| 2. P1, SM-5. Deletion failure reported as success | Confirmed failure injection showed storage returning false or failing after graph and job purge while orchestration still reported success. The store also collapsed removal errors into false. | The store throws removal errors. The server maps false or storage exceptions to 500 `delete_failed`. [chat-operations.test.ts](../tests/chat-operations.test.ts) covers both results and queue release for retry. [durable-store.test.ts](../tests/durable-store.test.ts), `hard deletion rejects a metadata removal failure and permits retry after partial removal`, covers a real unlink failure after runtime removal. No rollback is promised. | Integrated. Final integrated checks passed. |
| 3. P2, SM-2. Client error recovery and stale work | Reported reproductions found that a failed send blocked later sends, stop during 409 wait still permitted reposts and stale errors, and a delayed dismissal failure could overwrite a newer send or attachment. Error-state dismissals were also blocked. | Sends and dismissals accept `error` but preserve busy gates. Retry cancellation checks both delay and jobs-poll boundaries. Consume ownership suppresses stale events and cleanup. Turn generations suppress stale dismissal errors after send or reattach. [session-core.test.ts](../tests/session-core.test.ts) contains parameterized regressions for each boundary, current-error reporting, and successful acknowledgment drain after stop. Started input and dismissal POSTs remain unabortable. | Integrated. Final integrated checks passed. |
| 4. P2, SM-4. Missed compaction frame | A missed final status frame left the compaction send gate stale. Initial investigation was code-traced. The implementing agent later reported browser reproduction with dropped frames and controlled reconnect. | Mount and reconnect fetch authoritative compaction status without replacing messages. Newer reads and frames invalidate older responses. [frontend-suite-compaction.mjs](../tests/browser/frontend-suite-compaction.mjs) drops frames, resyncs during and after summary, and asserts transcript preservation. | Integrated. Final integrated checks passed, including the frontend browser suite. |
| 5. P2, SM-6. Competing cold or kick compaction | Confirmed controlled interleaving let another summary register while a cold gate awaited `getChat`. The gate saw the registry entry and returned without waiting, allowing model-facing work to overlap summary. | Join the competing promise instead of returning immediately. [compaction-service.test.ts](../tests/compaction-service.test.ts), `the turn-start gate waits for a ${competitor} that starts during getChat`, exercises both a cold gate and settlement kick and asserts no early completion. | Integrated. Final integrated checks passed. |
| 6. P2, SM-3. Settings sanitation bypass | Reported reproduction retained `compaction.thresholdTokens: -5` without graph but dropped it with graph. Unknown-key copying restored known sections rejected by validation. | Sanitize compaction independently and exclude all known sections from unknown-key copying. [settings.test.ts](../tests/settings.test.ts) covers malformed sections, rejected object contents, and graph presence. [settings-store.test.ts](../tests/settings-store.test.ts) covers disk read and write round trips with real unknown keys retained. | Integrated. Final integrated checks passed. |

The coordinator reports refuting a suspected plain-text duplicate on ordinary
409 retry. The implementation submits final plain text through `root.submit` rather than
the preceding append list. That result does not prove every answer,
multi-marker, or interrupted-write path is exactly-once.

## Additional integrated fixes

| Work | Current implementation | Verification limit |
| --- | --- | --- |
| Marker-only compaction commit | [compaction.ts](../src/session/compaction.ts) passes only `[marker]` to `saveMessages`, preserving concurrent transcript edits. | Dismissal and reopen assertions are in `tests/compaction-dismissal.test.ts`. The final integrated test suite passed. |
| Retain pending question during compaction | [session/model/compaction.ts](../src/session/model/compaction.ts) pins the cut to the pending call's assistant and retains the entire following tail. | Pure cut and provider-input assertions passed in the final integrated test suite. Obsolete summary projection remains open below. |
| Artifact job prop forwarding | Research and PDF forward jobs through `ArtifactPart` to `DispatchCard`. | Dispatch browser assertions exist. The final integrated frontend browser suite passed. |
| Partial graph deletion retry | The chain-table parent retains failed and unattempted nodes after partial success. | Deferred browser assertions cover HTTP and network failures. The final integrated frontend browser suite passed. |

## Ranked open confirmed issues

All five issues are OPEN, NOT FIXED. Evidence below comes from supplied
reproductions and code tracing, not new runs in this documentation pass.
Temporary reproduction files are not permanent project references.

| Rank | Reachable failure and concrete evidence | Current code and limits | Status |
| --- | --- | --- | --- |
| 1. P1. JSON replacement loses old data | Fault injection after truncation left settings, sources, render settings, and chat metadata at zero bytes. Reads hid the old records. Section retry and source reimport did not recover siblings or usage. | As traced, `writeSettings`, `writeSourceMap`, `writeRenderSettings`, and `writeMeta` used direct `writeFileSync`. Current code: `src/settings/store.ts:writeSettings`, `src/graph/store.ts:writeSourceMap`, and `src/session/store.ts:writeMeta` call `writeJsonAtomic` (`src/platform/fs.ts`); `writeRenderSettings` is removed. SQLite chat history survived. Injection proves a reachable interrupted-write failure, not its real-world frequency or power-loss behavior. | OPEN as traced. Current code uses temporary-file-and-rename for the three remaining writers, without an owner-only mode. Private-file replacement approved. A controlled ACL reproduction showed copying mode bits alone can broaden read access, so the user selected owner-only POSIX replacement, not yet implemented. |
| 2. P2. Stale whole-section settings overwrite | Real route calls with two stale `agent` bodies both returned 200. Disabling demo removed the previous research override. A second body based on the first response preserved both. | Section PUT replaces the section. `SettingsDialog.svelte` adopts responses without write ordering. UI timing is code-traced, not browser-proven. Different-section synchronous server writes survived the reproduction. | OPEN, NOT FIXED. |
| 3. P2. Desktop startup leaves an invisible locked process | Isolated real-Electron runs left no window after missing-server startup. The unchanged production main process remained alive after 33 seconds, and a second launch exited without starting a server. | `electron/main.cjs:startServer`, `waitUntilUp`, and the ready callback have no common startup-failure cleanup. A connected but silent HTTP endpoint also leaves readiness pending. The controlled run is not evidence of frequency on packaged user installs. | OPEN, NOT FIXED. |
| 4. P2. Obsolete summary reaches provider input | With an 84,000-character prior summary, the reproduction completed two summaries. The captured actual provider request contained both `OBSOLETE_PRIOR_SUMMARY_` and `LATEST_SUMMARY_ONLY`. The pending question also survived. | `src/session/model/transcript.ts:toLlmMessages` skips only the active marker after prepending its summary. An older marker inside the kept tail renders as user text. The large injected summary establishes reachability, not normal provider output size or measured answer harm. | OPEN, NOT FIXED. |
| 5. P3. Failed source build deletes the previous payload | A curated payload first served HTTP 200. With adapter `handler.js` missing, source startup exited 1 and deleted that payload. Direct restart then failed with `MODULE_NOT_FOUND`. | `scripts/build-server.mjs:buildPayload` calls `fail`, which removes the payload. `scripts/start-server.mjs` rebuilds before import. This deletes generated output, not user data, in the isolated reproduction. | OPEN, NOT FIXED. |

Marker-only persistence and pending-question retention do not fix obsolete
summary projection. The compaction cut can retain a previous marker when that
marker follows the pinned question. Only the active marker is skipped in the
projection loop, so the previous summary remains model-visible.

## Remaining verification boundaries

- No tests, browser sessions, provider calls, microphone sessions, or crash
  processes ran in this documentation pass. Existing assertions and reported
  reproductions are distinguished above.
- The coordinator observed passing typecheck, lint, all 1,841 tests in
  `npm test`, and the production Vite build in the final sandbox checks.
  The standalone build first failed because the temporary filesystem exhausted
  its inodes. It succeeded after cleanup, not on the first attempt.
- The final frontend browser suite passed all 44 checks. The separate
  optimistic-message browser regression also passed. These results do not
  establish exhaustive state coverage or resolve the five open issues above.
- Sandbox evidence is in `/tmp/lh-state-verify/final-validation.log` and
  `/tmp/lh-state-verify/final-browser.log`. The validation log records the
  initial standalone failure. The coordinator reports the successful retry
  after cleanup. These temporary logs are not permanent project references.
- All 103 relative source and test links resolve against the inspected
  integrated tree.
- Dependency scheduler, transaction, retry, and provider cancellation internals
  were not audited. Request identity does not prove that an external tool side
  effect cannot repeat after a crash.
- No exhaustive interleaving proof covers admission, deletion, settlement,
  steer delivery, extraction cancellation, graph merge, and compaction together.
  Multi-waiter audit cancellation, merge handoff cancellation, and deletion
  during background summary work need focused checks before stronger claims.
- Multi-process writers and cross-file crash atomicity were not verified.
- Setup-stage selection, key ownership, custom endpoints, desktop startup,
  practice gating, and selected graph transitions are code-traced above. The
  full setup dialog, prompt editing, notes-import retries, all graph interaction
  schedules, rich renderers, and remaining dialogs were not inventoried
  transition by transition.
- Actual dialog response timing, focus restoration, and dictation cleanup on
  every navigation path remain unchecked. The route-level stale-section loss
  is confirmed separately above.
