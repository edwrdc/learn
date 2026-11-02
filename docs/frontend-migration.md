# Frontend migration

The application now uses SvelteKit with adapter-node and Svelte 5. The browser keeps server-rendered pages. Electron runs the same application through its existing loopback server and narrow preload bridge. The React and Next.js implementation and dependencies are removed.

This is a frontend and transport migration, not a storage or agent-engine migration. Existing chat URLs, teaching and practice sessions, graph views, settings, artifacts, fonts, keyboard actions, and accessibility contracts remain supported. Backend changes are limited to the packaged prompt-root seam and updated comments.

## Approved decisions

- Keep SSR and use direct file-based routes. There are 32 API endpoint files with 40 explicit methods. The page URLs remain /, `/chat/new`, `/chat/[id]`, and `/settings`. The last redirects to `/chat/new` with status 307.
- Keep one long-lived Node process. Turn ownership, queues, the event bus, and durable handles are process-local. Do not use a serverless adapter or multiple workers.
- Keep loopback binding. The server has no request authentication and must not be exposed on a public interface.
- Keep CSRF enabled. The packaged launcher stamps its own HTTP protocol header before importing the adapter handler. File imports retain the previous uncapped body-size policy.
- Reuse `ChatRecord`, `LhMessage`, `projectView`, the framework-free `SessionModel`, and `GraphCanvasRenderer`. Do not introduce a second backend or UI protocol.
- Keep `pi-ai`, `pi-durable`, and `chord` pinned to 1.4.0 and retain the `pi-durable` postinstall patch.
- Use Vite's environment-file priority and interpolation for source commands. This was an explicit choice. Mode files outrank `.env.local`, unlike Next.js. Existing shell values win, including empty values. The source entry loads file values into `process.env` for the existing backend. Packaged launches do not load dotenv files.
- Keep browser checks separate from CI. This was an explicit choice. They use a separately installed agent-browser CLI, tested with 0.38.1. No browser-test dependency was added to the application.

## Runtime and module ownership

The toolchain pins Svelte 5.57.3, SvelteKit 2.70.3, adapter-node 5.5.7, and Vite 7.3.7. Vite development uses port 3000. `dev:fresh` explicitly forwards its separate port.

The build writes `dist-server/`. `scripts/build-server.mjs` curates `dist-server/standalone/`. Electron ships that directory at `Resources/server/standalone/`, outside `app.asar`. The shell and updater remain inside `app.asar`.

Runtime packages remain external to the server bundle. The payload builder parses actual server imports and preserves installed dependency paths, including nested versions. It rejects missing dependencies, secrets, user data, checkout files, and missing platform-native binaries. Before replacing an existing payload, it refuses if that payload contains mutable data or a root auth file. Vite runs the same guard before adapter cleanup. Boot smokes copy the payload outside the checkout so Node cannot hide a missing package by resolving it from the checkout.

UI domain imports use the core barrel. Server handlers and loads can also use the server barrel. ESLint tests cover both allowed imports and rejected client-to-server imports. The client Vite build substitutes a throwing crypto module for unused server-only hashing imports in shared core modules. SSR keeps native Node crypto.

## Preserved data and protocols

The migration does not change durable record formats, message IDs, schema stamps, Python readers, golden fixtures, or storage ownership. Chat metadata remains JSON. Durable transcripts and runs remain per-chat SQLite databases. Back up the entire data directory, including SQLite WAL and SHM files. Source starts keep the repository-level data/ and auth.json defaults outside regenerated output. Explicit nonempty path overrides still win.

`POST /api/chat` still acknowledges an input event before generation finishes. `GET /api/chats/:id/stream` still replays and streams the durable run. `GET /api/events` still sends fact-only change notifications. Disconnecting a page does not cancel the turn. Explicit abort remains the cancellation protocol.

The Electron bridge, local-storage keys, existing fonts, and static-asset URLs remain unchanged. The browser cannot import the server or store layers.

## Corrections found during verification

- An initial packaging pass was withdrawn. Missing imports resolved from checkout dependencies. The corrected builder preserves the complete installed dependency graph, and isolated negative controls fail when a required package is removed.
- A redundant mount fetch replaced an optimistic first message with a stale empty record. Removing that fetch restores the previous behavior. The browser regression delays the first POST and checks the bubble before acknowledgment and after persistence.
- Missing strong-slot key checks allowed an orphan chat. Home and new-session sends now use the existing `strongKeyless` guard before creation.
- SvelteKit's environment modules did not populate `process.env` for the existing backend. The source-only Vite loader restores file-backed keys without packaging those files or values. `dev:fresh` also forwards its port to Vite.
- A source startup default placed new records inside regenerated output. The source entry now sets the original repository-level data and auth paths before curation. A real dev-to-production restart probe preserves both chats, SQLite, and file-backed keys. The builder also refuses to overwrite mutable files left inside an old payload.
- Chain selection buttons lost their counted accessible names, and expanded rows lost their tree guides. Both match the baseline again. A negative run on the earlier payload fails the guide check.
- The initial browser driver could activate covered controls through a JavaScript fallback. The driver now uses native clicks. A positive and negative control proves that visible controls work and covered controls do not activate.

## Verification record

Qualification in the original workspace passes a fresh offline `npm ci`, typecheck with zero errors and warnings, lint, 1,773 deterministic tests, the adapter build, payload curation, and isolated host-Node and Electron-Node boot and carrier smokes.

The browser gate passes 39 checks plus the focused optimistic-message regression. It exercises real pages, user actions, API persistence, live turns, research-job completion and abort, settings, notes import, selection, accessibility, coverage, and graph presentation. Scripted providers run on loopback. Some rendering states use labelled API-boundary fixtures. The update-banner checks use a labelled preload mock and do not prove native updater behavior.

The Linux unpacked-package qualification exercises the actual Electron 44.9.3 binary with Node 24.22.0. It checks `app.asar` contents, packaged dependency confinement, real HTTP and SQLite, and packaged PDF text extraction and drawing with the bundled fonts and native canvas. No signing or publishing runs.

See the [development guide](development.md) for commands and the [desktop build guide](desktop-release.md) for packaging. Browser checks remain a separate gate, not part of `npm test` or CI.

## Test coverage mapping

The baseline had 2,162 tests. The port consolidates the React render suites into 245 Svelte render and pipeline tests, retains backend and portable-helper tests, and adds browser interaction coverage and startup tests. Test totals are not assertion totals, and this is not a claim of one-to-one test-case identity.

The [file mapping](frontend-test-port.tsv) records all 59 affected test files. The [interaction mapping](frontend-interaction-coverage.tsv) records 85 final contract dispositions, including adaptations for retired React-only call interfaces. The earlier temporary render oracle is gone. No known listed contract remains unported.

## Principles to choices

| Principle | Specific choice it changed |
|---|---|
| Laziness Protocol | Kept direct file-based routes and the existing handlers. No custom router, no backend rewrite, no new abstraction layer. |
| Foundational Thinking | Kept `ChatRecord` and `SessionModel` as the shared data and state shapes, and put the runtime gate first so the transport was proven before the UI port. |
| Boundary Discipline | Kept route validation and status codes, kept client and server separated by the import law, and kept CSRF and origin handling at the server boundary. |
| Model the Domain | Reused the chat record and session model instead of a parallel UI model. Kept the payload closure keyed by installed package directory so nested versions stay correct. |
| Prove It Works | Verified the real packaged artifact, not a build log. The smokes run outside the checkout and include negative controls. |
| Sequence Work into Verifiable Units | Staged the work as baseline, carrier, payload, render port, cleanup and final run, each with its own gate. |
| Separate Before Serializing Shared State | Ran the migration in an isolated worktree with owned scopes. No shared branch or shared file had two writers. |
| Outcome-Oriented Execution | Treated the carrier shell as temporary validation scaffolding, not a shippable intermediate, and converged on the final SvelteKit shape. |
| Build the Lever | Kept rerunnable smokes, payload tests and boundary tests as the review artifact instead of one-off checks. |
| Test Behavior, Not Implementation | The UI gate asserts visible content and interactions through the public contracts, not component internals or file layout. |

## Limits and distribution

Real provider quality, microphone and Deepgram hardware, native window controls, GPU behavior, and native updater installation were not exercised. macOS and Windows packages were not run locally. The browser preload mock is not a native Electron IPC test. Linux qualification used an unpacked directory, not AppImage or deb installation.

This migration makes no performance claim and does not change release or signing policy. The update feed still points to amosblomqvist/learnharness. Review that feed before distributing the fork. No release, signing, or deployment was performed during verification.

One earlier browser run timed out waiting for the key input after a provider selection. Eight isolated repeats and the final full command passed without a code change. The cause was not established; this remains an intermittent browser-test risk.
