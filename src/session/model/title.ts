/** The auto-title's character cap: long enough to
 *  stay informative in the sidebar and the top bar, short enough that a
 *  first message never reads as a paragraph. Tunable — one number, one
 *  place. */
export const TITLE_MAX_CHARS = 72;

/** Derive a short chat title from the learner's first message (pure).
 *  Smart truncation: the cut snaps to a word boundary
 *  AT OR UNDER the cap — a title never ends mid-word. The one exception
 *  is a single word longer than the cap (rare, but real: identifiers,
 *  URLs): it cuts at the cap, splitting the word. Whitespace collapses to
 *  single spaces first, so boundaries are always single-space boundaries.
 *  Used on chat creation; deterministic so tests can pin it. */
export function titleFromPrompt(prompt: string): string {
	const oneLine = prompt.replace(/\s+/g, " ").trim();
	if (oneLine.length <= TITLE_MAX_CHARS) return oneLine;
	let cut = -1;
	for (let i = TITLE_MAX_CHARS; i > 0; i--) {
		if (oneLine[i - 1] === " ") {
			cut = i - 1;
			break;
		}
	}
	// One long word: no boundary exists under the cap — split it. This also lands correctly when the first word exactly
	// fills the cap: cutting at the cap IS the boundary.
	if (cut < 0) cut = TITLE_MAX_CHARS;
	return `${oneLine.slice(0, cut)}…`;
}
