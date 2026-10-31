<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# No guessing

All design authority belongs to the human. **Never guess a design or implementation decision.** If anything is ambiguous — naming, behavior, data shapes, UX, defaults, scope boundaries, prompt wording — STOP and ask with the ask-user-question tool before proceeding. If you are "a little unsure," you are unsure: ask. A wrong guess is far more expensive than a question. Ask early, ask specific, one question per call.

Concretely: first investigate and plan rigorously (asking the user design questions along the way), get the plan approved by the user, and only then implement. Implementation should be mechanical execution of an approved plan — not interpretation.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `agent`, `server`, `app`, `store`.

Examples: `fix(app): simplify thinking toggle styling`, `docs: update contributing guide`, `chore(app): regenerate types`.

# Pstack in Pi

Pstack workflows are optional. Their `.agents` model, skill, and reference
assets are private and ignored, so a fresh checkout lacks them. Before starting
a selected workflow, verify its required local model file and every required
skill/reference file. If any are missing, stop only that workflow and ask the
human to restore the private assets or specify another approved settings source.
Do not invent role models, silently use global defaults, force-add `.agents`,
or remove its ignore rules. Other work does not require these optional assets.

For pstack workflows in this repository, read `.agents/pstack-models.md` before
launching subagents. It overrides pstack's global model files, default models,
and automatic effort/speed adjustments. `/setup-pstack` updates this local file
only; do not write global settings.

- Pstack's `Task` means Pi's `subagent` tool. Use Pi's `todo` tool for playbook
  progress tracking, not for agent launches.
- The parent selects the role from the active skill or playbook, reads its
  configured entry, and passes explicit `model` and `thinking` fields at launch.
  A model mentioned only in the task prompt does not select the child's model.
- Use `general-purpose` for pstack delegates. For `poteto-agent`, instruct it to
  read `.agents/skills/poteto-mode/SKILL.md` in full first. For Comment Sicko,
  use `.agents/skills/no-comments/references/comment-sicko.md` as its prompt.
- Include absolute paths to this `AGENTS.md` and the local model file in each
  delegate's brief, and require it to follow them for any nested delegation.
- Launch parallel panels with `children`, one child per configured entry.
  Select only one entry from `arena cross-judge pool`, preferring a different
  model family from the parent's, as the Arena skill specifies.
- Keep the configured effort levels fixed. Do not silently substitute models
  or effort levels. If a model or effort is rejected, report it and ask. If a
  role has no clear mapping, ask before launching it.
- Leave the parent chat's model unchanged. These rules do not grant autonomy
  beyond this repository's approval requirements.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Validate unknown values once at the boundary that owns them. Pass typed values inward instead of repeating `typeof value === "object"` and property-existence checks. Do not defensively revalidate values already guaranteed by a schema, constructor, or internal type.
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness.
