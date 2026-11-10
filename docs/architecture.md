# Learning Harness — Architecture

How the code is laid out and how the main flows run. The code is the source of truth; when this doc and the code disagree, the code wins and this doc is wrong. Product reasoning lives in [`vision.md`](vision.md); the pre-refactor spec is kept in [`archive/architecture-2026-09-08.md`](archive/architecture-2026-09-08.md) as history.

**What this is.** A standalone learning app (web + Electron desktop). A prober agent assesses the learner, a teacher agent authors a plan tree and teaches with structured questions, practice sessions drill material, background sub-agents research, build demos, draw figures and read PDFs, and an extraction pipeline folds every session (and imported notes) into one persistent knowledge graph — the home page.

**Stack.** SvelteKit 2 + Svelte 5 (runes), TypeScript, `adapter-node`. The agent runtime is pi-ai (providers) + pi-durable (one SQLite-backed durable store per chat). The desktop app is an Electron shell that spawns a packaged copy of the SvelteKit server.

---

## 1. Layout: feature folders

`src/` is split by **feature**, not by layer. Each feature folder has:

- `model/` — pure, browser-safe types and logic (no IO), re-exported through `model/index.ts`;
- `index.ts` — the feature's server surface (what other features and routes may call);
- everything else — internal to the feature.

| Path | Owns |
| --- | --- |
| [`src/boot.ts`](../src/boot.ts) | The composition root: `boot()` and `services()` (§3). |
| [`src/stores.ts`](../src/stores.ts) | The store instances (`stores.chatStore`, `graphStore`, `jobStore`) and `effectiveSettings()`. |
| [`src/activity.ts`](../src/activity.ts) | `activityFeed()` — the activity dock's payload: running jobs across all chats, extraction runs, `graphRevision`. |
| [`src/hooks.server.ts`](../src/hooks.server.ts) | SvelteKit `init` hook: calls `boot()` once at server start. |
| [`src/platform/`](../src/platform) | Lowest layer. `config.ts` (`ROOT`, `PATHS`, `SETTINGS_FILE`, `PROMPTS_OVERRIDE_DIR`, `AUTH_FILE`), `engines.ts` (pi engines, `routedModels`/`bindRunEngine`, `modelSnapshot`), `http.ts` (`readJson`, SSE framing), `fs.ts` (atomic writes), `events-stream.ts` (the `/api/events` SSE response), `provider-events.ts` (env-gated provider stream recorder), `durable-entries.ts`. `model/`: the server event bus (`events.ts`), `processState`/`keyedLock` (`process.ts`), ids, token estimate, abort helpers, fuzzy search. |
| [`src/settings/`](../src/settings) | `settings.json` persistence (`store.ts`), API keys (`keys.ts`, `auth-store.ts`), the custom endpoint (`custom-endpoint.ts`), the model catalog (`model-catalog.ts`), the live search engine (`search.ts`). `model/`: settings shape and factory defaults (`settings.ts`), the field schema (`schema.ts`), resolution (`resolution.ts`), refusal envelopes, model keys, graph render settings (`graph-render.ts`), the keyboard registry (`keyboard.ts`), prompt-segment grammar. |
| [`src/tools/`](../src/tools) | The tool catalog (`model/catalog.ts`), the pi-durable tool adapter (`adapter.ts`), execution helpers (`execute.ts`), argument healing (`heal.ts`, `model/argument-heal.ts`), file tools (`fs/`), web search/fetch (`web/`), PDF operations (`pdf-ops.ts`, `pdf-read.ts`). |
| [`src/session/`](../src/session) | Chats: metadata store (`store.ts`), the per-chat durable runtime (`durable.ts`), conversation setup (`durable-registry.ts`), one turn (`turn.ts`) and its services (`turn-service.ts`), turn liveness and handles (`turn-liveness.ts`, `turn-runs.ts`), compaction, prompts (`prompts/` markdown tree + `prompts.ts`), the prober/teacher/practice tools (`tools/`), the SSE view of a run (`pi/durable-turn.ts`). `model/`: transcript projection, input events, phases, questions, plan tree, prices, cost summaries. |
| [`src/jobs/`](../src/jobs) | Background runs: roles (`roles/`), the durable background-run engine (`durable-run.ts`, `runtime.ts`), the job runner (`runner.ts`), the wake pipeline (`wake.ts`), job tools (`tools.ts`), headless verification (`headless.ts`), the job store. `model/`: job records, steer builders, activity feed types. |
| [`src/graph/`](../src/graph) | The knowledge graph: ledger store (`store.ts`, file constants in `files.ts`), snapshot/derivation and the merger (`snapshot.ts`), coverage (`coverage.ts`), layout settle, positions, the read/delete service (`service.ts`), the format stamp. `extraction/`: the pipeline. `model/`: graph types, chain rules, findings schemas, clusters, layout, deletion. |
| [`src/routes/`](../src/routes) | SvelteKit pages and `api/` endpoints. Thin: parse, call a feature, map to HTTP. |
| [`src/lib/`](../src/lib) | The UI (§10). |
| [`electron/`](../electron) | The desktop shell (`main.cjs`, `preload.cjs`); constants shared with the renderer in `shared.json`. |
| [`scripts/`](../scripts) | Packaging, smoke gates, maintenance scripts (§12). |
| [`tests/`](../tests) | `node:test` suites (`*.test.ts`, support files `support-*.ts`), `browser/` (the agent-browser suite against a packaged server), `fixtures/`. |

Data lives in `LH_DATA_DIR` (default `./data`): `chats/<id>.json` (metadata), `durable/<chatId>/harness.sqlite` (transcripts and runs), `graph/` (ledgers, `sources.json`, `positions.json`, `format.json`), `jobs/<id>.json`, `prompts/` (prompt overrides), `settings.json`. Secrets live in `auth.json` (`LH_AUTH_FILE`) or `.env.local`, never in `settings.json`.

---

## 2. Import rules and dependency direction

[`eslint.config.mjs`](../eslint.config.mjs) has one job: `import/no-restricted-paths` zones between feature folders. The features it knows are `platform`, `tools`, `settings`, `graph`, `jobs`, `session`.

| Zone | Rule |
| --- | --- |
| `src/<feature>/model/**` | Imports only other features' `model/` folders (and npm packages). |
| `src/<feature>/**` | Imports another feature only through its `index.ts` or `model/index.ts`. |
| `src/<feature>/**` | Never imports `src/lib` or `src/routes`. |
| `src/lib/**` | Imports only its own subtree and the features' `model/index.ts`. |
| `src/routes/**/*.svelte` | Imports only `src/routes`, `src/lib` and `model/index.ts`. |
| `src/routes/**` (server) | Imports `src/routes`, `src/lib`, `model/index.ts`, the features' `index.ts`, and `src/stores.ts`, `src/boot.ts`, `src/activity.ts`. |

`tests/`, `scripts/` and `electron/` are lint-ignored. [`tests/lint-boundaries.test.ts`](../tests/lint-boundaries.test.ts) proves each zone fires.

The lint rules do not fix a direction between features; the code keeps one:

```
routes ─► boot / activity / stores ─► session ─► graph ─► jobs ─► settings, tools ─► platform
                                         └──────────────► jobs
```

- **platform** is the lowest layer. Its only upward reference is a `model/` import (`DEFAULT_THINKING_ORDER` from `settings/model`).
- **settings** and **tools** sit above platform. `tools/` imports no other feature. `settings/` imports `platform` and `tools` (catalog facts for tool toggles, search providers).
- **jobs** is the background-run engine. It imports `session` and `graph` only as **types** from their `index.ts` (`ChatRuntime`, `GraphDeps`) and pure helpers from their `model/` folders — never their server code. What it needs from session at runtime arrives through `configureBackgroundRuns(...)` (§3); the extraction and compaction roles arrive through `registerDurableRoles(...)`.
- **graph** and **session** import `jobs` (the durable role contract, the job store, steer delivery).
- **session** imports `graph` (coverage, extraction trigger, prober graph tools).
- **The one remaining back-edge:** `graph`, `session` and `settings` still import the root [`src/stores.ts`](../src/stores.ts) (`stores` / `effectiveSettings`), which in turn imports `session/store.ts`, `graph/store.ts`, `jobs/store.ts` and `settings/store.ts` directly.

---

## 3. `boot()` — the composition root

[`src/boot.ts`](../src/boot.ts) runs once per process (the SvelteKit `init` hook, tests and scripts all call it). Its result lives in `processState("services")`; a second call with different options throws. `services()` reads what boot built and throws before boot.

What `boot()` wires:

1. `initAuthEnv()` — reflects `auth.json` keys into `process.env` (real env vars win).
2. `createJobRunner({ chatStore, jobStore, deliver: deliverJobResult, engineFor, providerKeyMissing, searchProvider })`.
3. `createExtractionPipeline({ ...stores, engineFor, providerKeyMissing, getChunkTokens })` — chunk size read fresh from `effectiveSettings().graph.extractionChunkTokens`.
4. The wake pipeline's seams: `setTurnRunner` (a wake turn is `handleChatInput`) and `setJobRespawn` (re-run an orphaned job).
5. `registerDurableRoles({ ...EXTRACTION_ROLES, compact: COMPACT_ROLE })` — the non-job background roles.
6. `configureBackgroundRuns({ resolveEngine, searchProvider, run: runBackgroundConversation, openRuntime: openChatRuntime, isTurnRunning, isCommittedRunLive, chatStore })` — the session functions the jobs feature cannot import.
7. `setRuntimeBootstrap(...)` — runs on every freshly opened chat database before it resumes: `resumeBackgroundRuns` then `resumeForegroundTurn`.
8. `configureTurns(app)` — hands the turns the job runner, the extraction pipeline and the `upkeep` flag.

Engines are resolved per role from settings at call time (`resolveEngine` → `resolveRoleSpec` → `engineForSpec`); `undefined` reaches the refusal gates (§8). The `engineFor` option replaces that for scripted test engines.

**`upkeep`** (default `true`) gates background upkeep: crash recovery at boot, the extraction trigger after turns, and compaction after turns. Tests pass `upkeep: false` because their chats are fixtures.

**Crash recovery** runs once per process (`processState("recovery")`) when upkeep is on: open every chat's runtime (so interrupted runs resume through the bootstrap), then `recoverStaleJobs()`. `services().recovered` settles when it finishes. Reads never recover.

---

## 4. The per-chat durable runtime

[`src/session/durable.ts`](../src/session/durable.ts): one SQLite database per public chat id at `data/durable/<chatId>/harness.sqlite`, opened by **one** pi-durable `Harness` owner per process (a `processState` slot map: `opening` → `open` → `closing`). The chat's transcript is the **root conversation**; background job, extraction and compaction runs are child conversations in the same file (notes imports use their source id as the owner).

- **Durable entries are the transcript.** `ChatRecord.messages` is a read projection (`projectEntries`) over every entry in order, with ContextEdits applied — never the compacted model window. Metadata (title, timestamps, plan tree, usage logs, settings) stays in `data/chats/<id>.json` ([`src/session/store.ts`](../src/session/store.ts), version-stamped; a file stamped newer than the build is refused).
- **Harness settings** (`harnessSettings()`): provider retries off, pi-durable's automatic compaction off (the app owns compaction), steering and follow-up modes `"all"`.
- **Open order:** open storage → `Harness.open` with `routedModels()` → root conversation (the chat id is the provider session id) → runtime bootstrap (reinstall extensions for interrupted runs) → `harness.resume()`. A failed bootstrap closes the harness and throws `ChatRuntimeInitError` (fail closed; the committed inputs stay for the next open).
- **Conversation setup** ([`durable-registry.ts`](../src/session/durable-registry.ts)): per turn, installs the phase's tool set (prober / teacher / practice), the question-stop hook, the request filter (hides the `lh.continuation` input and applies the compaction cut), and configures model, thinking level, prompt and enabled tools.
- `scripts/patch-pi-durable.mjs` (run by `postinstall`) patches the exact pi-durable version for the question stop, input park and hook entry read.

---

## 5. One turn

[`src/session/turn.ts`](../src/session/turn.ts) is the turn composition: `POST /api/chat` carries `{ chatId, input }` — one explicit input event, never a client transcript. `handleChatRequest` parses it; `handleChatInput` runs it (the wake pipeline calls the same function).

In order, under the chat's operation lock:

1. **Open** the runtime (`openChatRuntime`); a `ChatRuntimeInitError` returns 503.
2. **Turn gate (BYOK):** resolve the chat's conversation engine (`resolveConversationSpec`: the chat's own model over the strong slot). No model, no provider key, or a model the catalog lost → the 503 refusal envelope.
3. **Compaction gate:** await any in-flight compaction for the chat, and compact synchronously if still over threshold (`ensureCompacted`). Nothing model-facing interleaves with compaction.
4. **Input appends** (`inputAppends`, pure); a wake whose markers all landed already does nothing.
5. **Question gates:** while a question is unanswered only an answer gets through (a steer wake gets 409 so the pump retries); an answer that leaves a sibling question pending writes and returns without a run.
6. **`beginTurn`** — one turn per chat per process (409 otherwise).
7. **Write-ahead:** an answer becomes a ContextEdit over the posed question's placeholder result (`answerWrite`/`applyAnswer`); other appends land before the run, except the last run-starting message, which the submission itself carries. Persisted steer markers flip their jobs (`noteSteerVisible`).
8. **Descriptor + submit:** `writeTurn` stores the durable admission descriptor (`ForegroundTurn`: model snapshot, phase, base entry count, settle state), `prepareConversation` configures the turn, then `runtime.root.submit(...)` with `whenBusy: "reject"` (`ConversationBusy` → 409). An answer submits the hidden `lh.continuation` input.
9. **`attachTurn`** registers the run's view ([`pi/durable-turn.ts`](../src/session/pi/durable-turn.ts) `runDurableTurn`) in `turn-runs.ts`. The POST returns `{ ok: true }`; every view attaches through `GET /api/chats/[id]/stream`.
10. **Settle services** (`settleForegroundTurn`, once per turn): run usage (`appendRunUsage`), steer reconciliation (`settleSteers`), plan blocks, the extraction trigger (upkeep), a parked dismissal, the durable settle mark, `endTurn`, re-pump of stranded steers, and the compaction settle kick (upkeep).

**Questions.** Question tools (catalog `kind: "question"`) commit a placeholder result and the patched after-tools hook stops the run and parks queued inputs. The learner's answer replaces the placeholder; the continuation starts the reaction run.

**Phases.** The phase comes from the transcript (`model/phases.ts`): prober until `probe_done`, then teacher; practice chats (`kind: "practice"`) use `prompts/practice/` and the `problem`/`conclude` tools and never trigger extraction.

**Recovery.** `resumeForegroundTurn` (from the runtime bootstrap) rebuilds a committed-but-unsettled turn from its descriptor before `harness.resume()`, and reattaches the same settle path; a finished-but-unsettled turn runs only its settle services.

**Compaction** ([`compaction.ts`](../src/session/compaction.ts)): the app owns threshold (`compaction.thresholdTokens`), summary and cut. The summary runs as the durable `compact` role on the chat's own engine. Triggers: the settle kick after a turn, and the turn-start gate.

**Prompts** ([`prompts.ts`](../src/session/prompts.ts)): `system-prompt.md`, then the agent's numbered fragments, then `shared/` fragments; practice composes only its own directory. User overrides live under `data/prompts/` and are switched by `settings.agent.prompts`. See [`src/session/prompts/README.md`](../src/session/prompts/README.md).

---

## 6. Background jobs

The teacher's job tools (`research`, `demo`, `visual`, `pdf`; [`src/jobs/tools.ts`](../src/jobs/tools.ts)) are server-executed and resolve at once with an acknowledgement: they create the job record and fire the runner through the `spawn` seam. The result comes back later as a steer.

- **Roles, defined once** ([`src/jobs/roles/`](../src/jobs/roles)): `role.ts` defines `DurableRole`/`JobRole` (prompt, tools, durable hooks, initial state, input → run → result); `research.ts`, `demo.ts`, `visual.ts`, `pdf.ts`; `registry.ts` maps `JobKind` → role. Extraction (`extract`, `audit`) and compaction (`compact`) roles register at boot.
- **The durable background-run engine** ([`durable-run.ts`](../src/jobs/durable-run.ts) contract, [`runtime.ts`](../src/jobs/runtime.ts) implementation): every background model loop is a child conversation in the owning chat's database. Its `RunDescriptor` (role, safe model spec, prompt, caps, input, role state) is a committed document, so a later process reinstalls tools, prompt and model binding before the run resumes (`resumeBackgroundRuns`). Role state that must survive a restart lives in the `RunState` union, committed before the tool result.
- **The runner** ([`runner.ts`](../src/jobs/runner.ts), `createJobRunner`): `runJob(jobId)` gates on the role's model slot and provider key (refusal envelopes), runs the role, builds the steer (`buildSubagentSteer`) — a failed job still steers — and hands it to `deliver`.
- **The wake pipeline** ([`wake.ts`](../src/jobs/wake.ts)): `deliverJobResult(chatId, steer)` queues the steer in a per-chat registry and a pump delivers it:
  - **live run** → submit into the durable inbox; the run places it at its next boundary (probe-handoff markers never take this path);
  - **idle** → wait until no turn runs and no question is pending, then one wake turn (`turnRunner` → `handleChatInput`) carrying every queued marker; 409 → back off and retry.
  Delivery is idempotent per steer id (`steerDelivered`). The job flips done/error only once its marker is in the record.
- **Recovery** (`recoverStaleJobs`, once at boot): re-deliver finished results, re-spawn unfinished loops.
- **Headless verification** ([`headless.ts`](../src/jobs/headless.ts)): the demo role runs its HTML, the visual role renders its SVG, through the app's browser service.

---

## 7. The knowledge graph and the extraction pipeline

**Storage** ([`src/graph/store.ts`](../src/graph/store.ts), files in [`files.ts`](../src/graph/files.ts)): append-only JSONL ledgers `nodes.jsonl`, `chains.jsonl` (reasoning chains — the stored truth; edges are derived), `sessions.jsonl` (checkpoints), `coverage.jsonl` (per-message coverage fingerprints); plus `sources.json` (notes sources), `positions.json` (layout), `format.json` (format stamp, `graph-format.ts`).

**The extraction pipeline is the sole graph writer** ([`src/graph/extraction/pipeline.ts`](../src/graph/extraction/pipeline.ts), `createExtractionPipeline`). Two sources, one pipeline:

- **chat source** — `runExtraction(chatId)`, fired by `triggerExtraction` ([`turn-service.ts`](../src/session/turn-service.ts)) after a turn when `graph.enabled`, the chat is not practice, and the uncovered teacher-prose tokens reach `graph.extractionChunkTokens`; or on demand via `POST /api/graph/coverage/extract`. Single-flight per chat. Batches come from `coverageOf`/`batchRuns` ([`coverage.ts`](../src/graph/coverage.ts)).
- **notes source** — `importNotes`/`importNotesFiles` (`POST /api/graph/import`, `scripts/import-notes.ts <dir>`): a file's source id (`src_` + path hash) plays the chat id; files chunk under the same token budget; an unchanged re-import is a no-op.

Stages, per batch/chunk (each its own job; a source's jobs run in order, sources run in parallel):

1. **extract** — a durable submit role ([`submit-role.ts`](../src/graph/extraction/submit-role.ts), [`submit-agent.ts`](../src/graph/extraction/submit-agent.ts)) that sees only the source (a session's teacher prose, or the notes text) plus the source's graph so far, and submits propositions + reasoning chains. Runs under a permit of the shared background-LLM pool — [`llm-slots.ts`](../src/graph/extraction/llm-slots.ts), `BG_LLM_PERMITS = 3`, FIFO and abort-aware.
2. **audit** — a durable role that never sees the source: it explores the graph with `find`/`list_sessions`/`list_propositions` ([`graph-tools.ts`](../src/graph/extraction/graph-tools.ts)) and submits identity links only. Audit + merge is a process-wide critical section (`withAuditLock`), so each audit sees the graph as it stands.
3. **merge** — deterministic (`mergeFindings` in [`snapshot.ts`](../src/graph/snapshot.ts)): link resolution, chain dedupe, `simplifyChains`, coverage checkpoints, then `settleGraphLayout`. A failure at any stage checkpoints nothing.

`extractionStatuses`, `abortExtraction` and `stopExtraction` drive the status feed and abort. Models: the `extractor`/`auditor` roles resolve through settings like any background role; an unconfigured model or missing key skips the run (the messages stay uncovered).

**Reads are derivation** (`graphView` → `graphSnapshot`/`deriveView`): each stored chain becomes an implication node (`arg_` id) with arrows premise → implication → conclusion; clusters are the birth-session partition (`model/session-clusters.ts`). `GET /api/graph` never writes. `graphRevision()` bumps on any graph file write; deleting a node (`deleteGraphNode`, `model/deletion.ts`) cascades to the chains that reference it. The only other graph write is `PUT /api/graph/positions` (`commitPositions`, layout only).

The prober and teacher reach the graph through `proberGraphTools` (`list_sessions`, `list_propositions`), gated by `graphToolsEnabled(effective)` (`agent.graphTools.enabled` with `graph.enabled`).

---

## 8. Settings, keys and models

**One record, one schema.** `data/settings.json` is a delta record (`UserSettings`, [`model/settings.ts`](../src/settings/model/settings.ts)): only explicit user choices; absent keys resolve to `FACTORY_SETTINGS`. [`model/schema.ts`](../src/settings/model/schema.ts) defines each field once with both directions — reading from disk drops invalid values and clamps numbers (never throws), writing a PUT body returns a 400 naming the field. Sections (`SETTINGS_SECTIONS`): `agent` (background role models, tool toggles, prompt switches, search engine, graph tools), `models` (the `strong`/`cheap`/`vision` slots), `appearance`, `graph`, `compaction`, `graphRender` (the graph view's render and physics sliders). `customEndpoint` is in the record but written through its own route. Unknown top-level keys on disk survive; the retired `chat` and `general` sections are dropped (`RETIRED_SECTIONS`). Routes: `GET /api/settings`, `PUT /api/settings/[section]`.

**Resolution** ([`model/resolution.ts`](../src/settings/model/resolution.ts)): `resolveSettings` → `EffectiveSettings` (every knob concrete); `effectiveSettings()` in `src/stores.ts` reads it fresh each call. Models are BYOK: no factory models exist. `resolveRoleSpec(role, settings)` follows the role override → slot (`ROLE_SLOT`); `resolveConversationSpec` applies the chat's own model over the strong slot (chats are stamped from the strong slot at creation).

**Refusal envelopes:** an empty model chain → `models_not_configured`; a model whose provider has no key → `provider_key_missing` (`RefusalCode`, both 503 with `{ error, code, ... }`). Turns, job spawns and extraction gate on them; the UI's `ApiError` carries the code.

**Keys** ([`keys.ts`](../src/settings/keys.ts), [`auth-store.ts`](../src/settings/auth-store.ts)): `auth.json` is a flat `{VAR: value}` map, mode 0600, re-read on every access; keys are reflected into `process.env` (real env wins). `GET/PUT/DELETE /api/keys`. **Custom endpoint** ([`custom-endpoint.ts`](../src/settings/custom-endpoint.ts)): one OpenAI-Responses endpoint, models discovered via `POST /api/custom-endpoint/models`, its key in the auth store. **Model catalog** ([`model-catalog.ts`](../src/settings/model-catalog.ts)): pi-ai's catalog for every keyed provider, projected for `GET /api/models`, plus the validation gate for model writes.

---

## 9. The tool catalog

[`src/tools/model/catalog.ts`](../src/tools/model/catalog.ts) lists every model-callable tool once in `TOOLS`: its `kind` (`question`, `practice`, `plan`, `job`, `side`, `submit`), `replaySafe`, `answeredByLearner`, the question dock kind, title, live activity label and sub-agent name. `QUESTION_TOOLS`, `JOB_KINDS`, `WRITABLE_TOOL_KEYS` (the settings tool toggles), `enabledTools` and the label helpers derive from it. Registries, the durable adapter ([`adapter.ts`](../src/tools/adapter.ts) `toRegistrations`, which reads the replay policy from the catalog), settings and the UI all read it.

Tool implementations live with their owner: question/plan/probe/practice tools in [`src/session/tools/`](../src/session/tools), job tools in [`src/jobs/tools.ts`](../src/jobs/tools.ts), role-private tools in each `src/jobs/roles/*.ts`, graph tools in [`src/graph/extraction/graph-tools.ts`](../src/graph/extraction/graph-tools.ts), shared file/web/PDF tools in `src/tools/`.

---

## 10. The UI (`src/lib`)

- **Typed API client** ([`src/lib/api/`](../src/lib/api)): one function per endpoint (`chats.ts`, `graph.ts`, `settings.ts`, `activity.ts`) over `http.ts` (`getJson`/`postJson`/`putJson`/`deleteJson`, `ApiError` with the server's `{error, code}` body, `path` template encoding).
- **Resource stores** ([`state/resource.svelte.ts`](../src/lib/state/resource.svelte.ts)): `Resource<T>` loads on first read, reloads on named server events, on `settings-saved` page events, on SSE reconnect and optionally on tab visibility, with a 250ms trailing debounce. Instances: `settings`, `activity`, `modelCatalog`, `keys`, `graphSnapshot`, `graphCosts`, `extractionRuns`.
- **Server events** ([`state/server-events.ts`](../src/lib/state/server-events.ts)): one `EventSource` on `GET /api/events` per window; consumers refetch on receipt (payloads carry only the fact). The vocabulary is `SERVER_EVENT_TYPES` in [`src/platform/model/events.ts`](../src/platform/model/events.ts): `turn-started`, `turn-settled`, `jobs-changed`, `activity-changed`, `chats-changed`, `record-changed`, `compaction-changed`.
- **Page events** ([`events.ts`](../src/lib/events.ts)): typed window CustomEvents between surfaces (`chat-renamed`, `turn-state`, `graph-revision`, `settings-saved`) and the keyboard action events.
- **Keyboard** ([`state/keyboard.ts`](../src/lib/state/keyboard.ts)): the single window keydown owner over the registry in `src/settings/model/keyboard.ts` (see [`keyboard.md`](keyboard.md)).
- **UI primitives** ([`src/lib/ui/`](../src/lib/ui)): the layer stack (`layer.ts` — open popovers/menus/dialogs; Escape and outside clicks close the newest), `MenuShell`, `ConfirmDialog`, pan/zoom, SVG helpers.
- **Feature folders:** `chat/` (the session page, its `SessionModel` in `session-core.ts` + Svelte adapter, composer, docks, plan views), `home/` (graph canvas and home pages), `settings/`, `shell/` (sidebar, top bar, activity), `markdown/` (rendering pipeline, math, mermaid, code), `artifacts/` (job result cards).

---

## 11. Routes

Pages: `/` (home graph), `/chat/new` (`?mode=practice` for practice), `/chat/[id]`, and `/settings`, which redirects 307 to `/chat/new`. `+page.server.ts` loads do the first-paint reads.

API (`src/routes/api/`, 31 endpoint files):

| Area | Endpoints |
| --- | --- |
| Turns | `POST /api/chat`; `GET /api/chats/[id]/stream` (SSE attach/replay); `POST /api/chats/[id]/steer`, `/dismiss`, `/artifact-ui` |
| Chats | `GET/POST /api/chats`; `GET/PUT/DELETE /api/chats/[id]`; `PUT /api/chats/[id]/settings`; `GET /api/chats/[id]/markdown` |
| Jobs and activity | `GET /api/jobs`; `GET /api/activity`; `POST /api/activity/abort` (`job`/`extraction`/`turn`); `GET /api/events` |
| Graph | `GET /api/graph`, `/costs`, `/status`; `PUT /api/graph/positions`; `DELETE /api/graph/nodes/[id]`; `POST /api/graph/coverage/extract`; `POST /api/graph/import` |
| Settings | `GET /api/settings`; `PUT /api/settings/[section]`; `GET /api/settings/prompts`; `PUT/DELETE /api/settings/prompts/[...segment]`; `GET /api/models`; `GET /api/keys`, `PUT/DELETE /api/keys/[id]`; `GET/PUT/DELETE /api/custom-endpoint`, `POST /api/custom-endpoint/models`; `GET /api/search`; `GET /api/stt/token` |

The server is one long-lived Node process: turn handles, locks, wake queues, the event bus and the SQLite handles are process-local (`processState`), so multiple workers or a serverless adapter would break reattach and exactly-once delivery. It binds loopback and has no request authentication.

---

## 12. Packaging and the desktop app

- **Build:** `npm run build` (Vite/SvelteKit, adapter-node), then [`scripts/build-server.mjs`](../scripts/build-server.mjs) curates `dist-server/standalone`: the server output, the pi engine and its native/SQLite closure copied outside the bundle, prompt assets, and [`scripts/server-launch.mjs`](../scripts/server-launch.mjs) as the entry. It fails if repo data or secrets would ship.
- **Launch entry:** `server-launch.mjs` sets `LH_ROOT`, stamps `x-forwarded-proto: http` so SvelteKit's CSRF origin check matches the plain-HTTP origin (CSRF stays on). Env contract: `PORT`, `HOSTNAME`, `LH_DATA_DIR`, `LH_AUTH_FILE`. `npm start` runs [`scripts/start-server.mjs`](../scripts/start-server.mjs).
- **Smoke gates:** [`smoke-server.mjs`](../scripts/smoke-server.mjs) (the payload boots and serves), [`smoke-carrier.mjs`](../scripts/smoke-carrier.mjs), [`smoke-demo-runtime.mjs`](../scripts/smoke-demo-runtime.mjs), [`smoke-provider-runtime.mjs`](../scripts/smoke-provider-runtime.mjs); they share [`smoke-harness.mjs`](../scripts/smoke-harness.mjs), which copies the payload outside the worktree and boots it the way `electron/main.cjs` does. `--electron` runs under Electron's Node.
- **Electron** ([`electron/main.cjs`](../electron/main.cjs)): a launcher and security guard, never an app-logic host. It spawns the packaged server with `ELECTRON_RUN_AS_NODE` on `127.0.0.1`, `LH_DATA_DIR` under userData and `LH_AUTH_FILE`; single-instance lock, deny-by-default permissions, origin-pinned navigation, sandboxed renderer. [`preload.cjs`](../electron/preload.cjs) exposes the IPC bridge; [`shared.json`](../electron/shared.json) holds constants shared with the renderer.
- **Release:** `npm run desktop:dist` chains build, build-server, the smoke gates (host and `--electron`) and electron-builder. See [`desktop-release.md`](desktop-release.md).

---

## 13. Testing

`npm test` runs `tests/*.test.ts` with `node:test` (`tsx`, concurrency 1). Engines are injected through `boot({ engineFor })` or per-turn injection; tests use pi-ai's faux provider, temporary data dirs (`support-tmp-data.ts`) and `upkeep: false`. `tests/browser/` drives a packaged server with agent-browser (`npm run test:browser`). Gates: see [`development.md`](development.md) and `AGENTS.md`.
