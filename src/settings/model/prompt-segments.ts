/**
 * The prompt-segment grammar, shared by the prompt loader
 * (src/session/prompts.ts) and the override routes.
 *
 * Path grammar: "system-prompt.md" (the shared base), "shared/<fragment>"
 * (composed by both prober and teacher), "prober/<fragment>",
 * "teacher/<fragment>", "practice/<fragment>" — where <fragment> is
 * numeric-prefixed + .md (e.g. 20-teaching.md). No traversal, no nesting.
 */

/** A prompt fragment: numeric order key + .md. Nothing else loads. */
export const FRAGMENT_RE = /^\d+-[\w.-]+\.md$/;

/** Which agent's prompt directory to compose. Practice composes only its
 *  own directory — no shared teaching base or fragments (its doctrine
 *  contradicts the teaching philosophy); its 00-base.md plays the base. */
export type PromptAgent = "prober" | "teacher" | "practice";

/** One segment of one agent's composed prompt. */
export interface PromptSegmentInfo {
	/** The override key, mirroring the source layout. The base and shared/
	 *  fragments use the same path in both agents' lists. */
	path: string;
	/** The source text (what the segment runs without an override). */
	sourceText: string;
	/** The user's override text, or null when no file exists on disk. */
	overrideText: string | null;
	/** Effective state: the settings switch AND the file both present. */
	enabled: boolean;
	/** True for segments both agents compose — the base and shared/ fragments. */
	shared: boolean;
}

/** Validate a segment path against the grammar. Routes also check
 *  membership in the current source segment list. */
export function isValidSegmentPath(segmentPath: string): boolean {
	if (segmentPath === "system-prompt.md") return true;
	const m = /^(prober|teacher|practice|shared)\/([\w.-]+\.md)$/.exec(segmentPath);
	if (!m || m[2] === undefined) return false;
	return FRAGMENT_RE.test(m[2]);
}
