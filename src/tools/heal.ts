/**
 * The universal argument heal, wired at pi's prepareArguments seam (before
 * TypeBox validation). Owner decision: one standard pattern applied at every
 * tool — heal what is mechanically recognizable (a JSON-encoded stand-in
 * for the schema-expected shape), let validation reject the rest. The pure
 * function lives in model/argument-heal.ts because the display parse needs
 * it too. Heals are idempotent, so a per-tool heal composed under this one
 * is a harmless second pass.
 */

import type { AppTool } from "./adapter.ts";
import { healEncodedArguments } from "./model/argument-heal.ts";

export { healEncodedArguments };

/** The tool's own prepareArguments runs first, then the heal against the
 *  tool's declared schema. */
export function withArgumentHeal(tool: AppTool<any>): AppTool<any> {
	const inner = tool.prepareArguments;
	return {
		...tool,
		prepareArguments: (args: unknown) => healEncodedArguments(inner ? inner(args) : args, tool.parameters),
	};
}
