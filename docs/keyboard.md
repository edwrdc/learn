# Keyboard shortcuts

Decided 2026-09-17 (owner key-map review after the first draft; the whole
app must be usable with the keyboard only — voice first, keyboard as the
second pillar of input).

## Architecture

- **Registry**: `src/settings/model/keyboard.ts` — `KEYBOARD_ACTIONS` holds every
  action: `{ id, label, scope, binding, displayOnly? }`. The cheat sheet
  (`src/lib/shell/CheatSheet.svelte`) and the settings keyboard section
  (`src/lib/settings/KeyboardSection.svelte`) render FROM the registry, so
  neither can list a non-functional shortcut.
- **Provider**: `src/lib/state/keyboard.ts` — `initKeyboard()`, one window-level
  keydown listener mounted once in `src/routes/+layout.svelte`. Normalizes
  keys to `mod+d`-style strings (`eventBinding`), resolves overrides
  (`actionForBinding`), handles navigation and dialog actions itself
  (`new-session`, `jump-graph`, `open-settings`, `cheat-sheet`) and
  dispatches the rest as `lh:kbd-<action-id>` window CustomEvents
  (`emitKeyAction`/`kbdEventForAction` in `src/lib/events.ts`). Surfaces
  listen for their own events.
- **Persistence**: overrides live under localStorage `lh:keymap` as
  `{actionId: binding}` merged over defaults (`loadOverrides`/`saveOverrides`);
  the settings keyboard section edits them.
- **displayOnly entries**: the registry also lists SURFACE-owned keys
  (the question dock's row machine) for the cheat sheet only —
  `effectiveKeymap` skips them so bare arrows can never leak to pages
  where the surface isn't mounted.

## Rules

- **Tab is dead everywhere** except the code field, where it inserts four
  spaces (owner decision: browser tab-focus navigation abandoned).
  Shift+Tab cycles the thinking level — also while typing in a field
  (modifier combos are the only keys that fire from typing surfaces; bare
  keys never do).
- **Esc priority chain**: topmost popover → cheat sheet → cancel
  dictation (DISCARD — the transcript flush is Cmd+D/Stop only, owner
  round) → code field returns focus to its prose field → abort turn
  (local stream only — a server-side wake turn has no client request to
  abort). Every element/document-level Esc handler that acts calls
  `e.stopPropagation()` so the window chain never double-fires. The
  session search claims Esc to blur back to normal.
- **Focus ring**: browser Tab-focus is gone, so `:focus-visible` stays
  unstyled (an earlier experimental outline was live-rejected — inputs
  showed a red ring on plain click-focus).

## Key map (Wave A — global)

| Action | Binding | Seam |
|---|---|---|
| Toggle dictation | ⌘D | `lh:kbd-toggle-dictation` (`src/lib/chat/dictation.svelte.ts`) |
| Open settings | ⌘, | `settingsDialog.open()` in `src/lib/state/keyboard.ts` |
| Model selector | ⌘K | `lh:kbd-open-model-picker` (`src/lib/chat/ModelControl.svelte`) |
| Cycle thinking level | Shift+Tab | `lh:kbd-cycle-thinking` (`src/lib/chat/ModelControl.svelte`) |
| Toggle sidebar | ⌘B | `lh:kbd-toggle-sidebar` (`src/lib/state/sidebar.svelte.ts`) |
| Sessions search | ⌘⇧F | `lh:kbd-sessions-search` (`src/lib/shell/Sidebar.svelte`) |
| Walk search results | ↑ / ↓ *in the search field* | `Sidebar.svelte` (cycles the filtered rows, wraps) |
| Open search result | Enter *in the search field* | `Sidebar.svelte` (walked row, else the first match) |
| ~~Cycle session~~ | ~~⌥↑ / ⌥↓~~ | RETIRED (owner, 2026-10-10) — the search walk above replaces it |
| ~~Open selected session~~ | ~~⌥Enter~~ | RETIRED (owner, 2026-10-10) — the search Enter above replaces it |
| Jump to graph (home) | ⌘G | `goto("/")` in `src/lib/state/keyboard.ts` |
| New session | ⌘N | `goto("/chat/new")` in `src/lib/state/keyboard.ts` |
| Rename session | F2 | `lh:kbd-rename-session` (`src/lib/chat/ChatPage.svelte`) |
| Toggle all your thinking | ⌘T | `lh:kbd-toggle-user-thinking` (`src/lib/chat/ChatPage.svelte`) |
| Cheat sheet | ? | `cheatSheet.open` in `src/lib/state/keyboard.ts` |
| Find | ⌘F | `lh:kbd-find` (graph node search in `src/lib/home/GraphView.svelte`; chat transcript search in `src/lib/chat/SessionFind.svelte`) |

## Model menu keyboard machine (owner polish, 2026-09-17)

(Removed from the settings/cheat-sheet registry 2026-10-10 — obvious
in-field navigation; the behavior below is unchanged.)

While the model menu is open, focus stays in the search field and the
menu owns ↑/↓/Enter inside the input's own handler:

- **↑/↓** walk the filtered results — clamped, no wrap. First ↓ starts at
  the first row; first ↑ at the last. The walked row gets a muted ring and
  scrollIntoView.
- **Enter** picks the walked row, or the **first result** when nothing is
  walked yet (owner decision). Typing a new query resets the walk.
- Clicking and Enter share one `pickModel` path; Esc still closes the menu.

## Question dock row machine (Wave B, owner rounds 2026-09-17)

While a question is expanded, the dock owns ↑/↓/Space/Enter/Tab:

- **↑/↓** walk every answerable row in order — options first, then the
  quiz's "I don't know" / the ask's "Other…" (never both) — **clamped at
  the ends, no wrap** (owner: faster to navigate when the walk stops).
  The walked row gets a subtle ring (`bg-accent/40`) and scrollIntoView.
- **Space** acts on the walked row exactly like a click: multi toggles,
  single displaces; Other also focuses its inline input for typing.
- **Enter** submits once an answer exists (`canSubmit`).
- **Tab (plain)** toggles focus between the thinking field and the
  answer rows — nothing else (owner round 3). From the thinking side it
  focuses the walked (or first) row; from the rows it returns to the
  thinking field. Focus follows the walk while the user is in the rows,
  so focused and walked never diverge. Shift+Tab is NOT the dock's —
  the global thinking-level cycle owns it everywhere.
- Guards: keys from a typing surface keep their native meaning (arrows
  move the caret, space types — the thinking field is never hijacked),
  and modifier combos are never the dock's — Alt+arrows cycle sessions
  without ALSO walking the question rows (owner round 3). The listener
  lives only while the dock is expanded — collapsed, the bar's native
  Enter expands it.

## Code field (learner code input)

Every code pane (home, chat, practice, question) follows one key
contract:

- **Enter / Shift+Enter** insert a newline. The field never submits on a
  bare Enter.
- **Ctrl+Enter / Cmd+Enter** runs the surface's existing action once
  (send, steer, stop, next, or submit). It keeps every existing gate:
  busy, configuration, compaction, and the selection-required question
  rules. It never fires during IME composition.
- **Tab (plain)** replaces the selection with four spaces and keeps
  focus in the field. The question dock's row machine never sees it.
- **Shift+Tab and modified Tab** bubble to global handling. Shift+Tab
  cycles the thinking level.
- **Esc** cancels active dictation first. Otherwise it returns focus to
  the sibling prose field and consumes the key. It does not clear the
  code, close the pane, or abort the turn. The next Esc in prose
  follows the normal app chain.
- **Add code** opens the pane and focuses the field after the mount
  tick. Draft restoration and prop updates never move focus. The pane
  stays open after a send for its mounted lifetime.

## Status

- Wave A (global plumbing + shortcuts above) — landed, CDP-verified.
- Wave B (question row machine) — landed, CDP-verified.
- ⌘F find ships on both surfaces (graph node search, chat transcript
  search). ⌘I import notes on graph is not in the registry.