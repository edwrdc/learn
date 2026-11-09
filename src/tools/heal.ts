/**
 * THE UNIVERSAL ARGUMENT HEAL — the agent-boundary wiring (owner,
 * 2026-10-09 — generalize the 2026-10-04 practice heal).
 *
 * Every weak-model argument wobble incident produced a heal wired ONLY
 * to the tool where it landed — parseOptionsIfString (questions,
 * 2026-09-26), healStringifiedArrays (extraction),
 * healEncodedArguments (practice, 2026-10-04) — and the whitehead death
 * loop (2026-10-09: quiz `type: "\"predict\""` rejected ten times,
 * byte-identical, in a session the lesson never reached) happened
 * precisely because the practice heal never reached the quiz tools. The
 * owner ruling: this is ONE standard pattern, applied at EVERY tool —
 * heal what is mechanically recognizable (a JSON-encoded stand-in for
 * the schema-expected shape; the membership-value debris strip lives in
 * core/value-debris), let validation reject the rest honestly.
 *
 * The pure function lives in core/argument-heal (the display seam needs
 * it too — the tool-parts law); this module is the per-tool/registry
 * wiring at pi's prepareArguments seam — BEFORE TypeBox validation.
 * Well-formed args pass through UNTOUCHED (same reference); heals are
 * idempotent, so a per-tool heal composed under the record-level
 * wrapper is a harmless second pass.
 */

import type { AppTool } from "./adapter.ts";
import { healEncodedArguments } from "./model/argument-heal.ts";

export { healEncodedArguments };

/** Wrap ONE tool with the standard heal: the tool's own prepareArguments
 *  (options-unwrap, target normalization, …) runs first, then the heal
 *  against the tool's declared schema. toRegistration applies it to every
 *  tool. Idempotent. */
export function withArgumentHeal(tool: AppTool<any>): AppTool<any> {
	const inner = tool.prepareArguments;
	return {
		...tool,
		prepareArguments: (args: unknown) => healEncodedArguments(inner ? inner(args) : args, tool.parameters),
	};
}
