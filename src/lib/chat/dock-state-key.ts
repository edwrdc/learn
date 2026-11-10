/**
 * The dock shell's variant key (the WAAPI height-morph trigger,
 * DockOverlay.svelte). Whenever this string CHANGES between
 * renders, the shell morphs its height (120ms) and re-reserves the
 * transcript tail; when it stays the same, height changes are measured
 * only (typing growth never animates).
 *
 * The expanded term (the fold: full form ↔ slim bar) belongs to EVERY
 * docked variant — question AND practice. It must not key on `pending`
 * (the question's tool call) alone: that is null in practice sessions,
 * and the practice dock would fold with an INSTANT height jump instead
 * of morphing. The fold machine treats practice as a dock owner too.
 */
export function dockStateKey(mode: string, docked: boolean, expanded: boolean): string {
	return docked ? `${mode}:${expanded}` : `${mode}:-`;
}
