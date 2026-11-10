# Prompt fragments

System prompts are composed per turn by `composeInstructions` in `src/session/prompts.ts` (called from the conversation setup in `src/session/durable-registry.ts`), one composition per agent — the probe/teach split (docs/probe-teach-split.md), plus practice. `listSourceSegments` gives the order:

1. `system-prompt.md` (this folder) — the SHARED base for the prober and the teacher: the agent intro, the philosophy (why the system exists). The teaching method (Principle i / Principle ii, the click, the arc, the hedge) lives in `teacher/05-method.md` — teacher-only since the prober never teaches.
2. Every numeric-prefix `*.md` fragment in the agent's directory (`prober/`, `teacher/` or `practice/`), in **sorted filename order**. The agent's own job and method LEAD the composition. The loader enforces the numeric prefix (`FRAGMENT_RE` in `src/settings/model/prompt-segments.ts`) — other files (like this README) never enter the model's prompt.
3. The `shared/` fragments, as a trailing appendix.

Segments are joined with `---` separators. A user override replaces a segment when its switch in `settings.json` `agent.prompts` is on and the override file exists under `data/prompts/` (mirroring this folder's layout).

**Practice** composes no `system-prompt.md`: `practice/00-base.md` plays the base, and only a curated subset of `shared/` is appended (`PRACTICE_SHARED_FRAGMENTS` in `src/session/prompts.ts`: voice, accuracy, mental-model, formatting) — practice has no question, confidence or file tools.

Rules for adding a fragment:

- Name it with a numeric order prefix, inside the right agent directory.
- `shared/` fragments compose into the prober and the teacher (after the base and their own fragments — a trailing appendix): cross-agent doctrine only, phase-neutral by construction (e.g. `10-voice.md`, `15-accuracy.md`, `20-question-tools.md` — tool MECHANICS only; what to ask is each phase's own doctrine — `30-learner-files.md`, `40-formatting.md`). A new shared fragment reaches practice only if it is added to `PRACTICE_SHARED_FRAGMENTS`. The "never reference the other agent's tools" rule below still applies, so shared fragments may only cover tools every composing agent actually holds.
- One fragment per workstream — your brief tells you which filename you own.
- Document YOUR agent's tools/behaviors exactly; reference tool input field names verbatim (they must match the tool schemas in `src/session/tools/` and `src/jobs/tools.ts`).
- Keep it tight: fragments are always in context. No restating the base prompt.
- The agents share one transcript but never one toolset — never reference another agent's tools as if you had them.
