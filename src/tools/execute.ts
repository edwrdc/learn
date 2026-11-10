import type { AppTool, AppToolResult } from "./adapter.ts";
import type { Static, TSchema } from "typebox";

/**
 * The execution machinery every server-side tool shares: the per-call
 * timeout + abort cascade, the input-refinement failure shape, the result
 * mapping, and the question-tool placeholder.
 *
 * Structural validation is not here: pi's loop validates arguments against
 * the tool's TypeBox parameters before execute runs. Refinements no schema
 * can carry run at the top of the tool's own execute and return
 * invalidInputResult.
 */

/**
 * Per-call timeout. pi's run AbortSignal only lands at a step boundary, so
 * a long-running local tool could otherwise hold a turn hostage. The guard
 * races every execute against the run's signal and this timeout, rejecting
 * with pi's own wording ("Operation aborted") on abort and a timeout message
 * otherwise — pi turns the throw into an error tool result the model sees.
 */
const TOOL_TIMEOUT_MS = 30_000;

/** How long an aborted/timed-out call may take to settle on its own before
 *  the hard reject lands — cooperative tools (the fs tools) poll the signal
 *  and return partial results within a tick or two. */
const TOOL_ABORT_GRACE_MS = 250;

function runWithAbortGuard<T>(
	toolName: string,
	run: (signal: AbortSignal) => T | Promise<T>,
	parent: AbortSignal | undefined,
): Promise<T> {
	const controller = new AbortController();
	const forwardAbort = () => controller.abort();
	if (parent) {
		if (parent.aborted) controller.abort();
		else parent.addEventListener("abort", forwardAbort, { once: true });
	}
	const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	const cleanup = () => {
		clearTimeout(timer);
		if (graceTimer) clearTimeout(graceTimer);
		parent?.removeEventListener("abort", forwardAbort);
	};
	return new Promise<T>((resolve, reject) => {
		const settle = (fn: () => void) => {
			controller.signal.removeEventListener("abort", onAbort);
			if (graceTimer) clearTimeout(graceTimer);
			fn();
		};
		const onAbort = () => {
			graceTimer = setTimeout(
				() =>
					reject(
						new Error(
							parent?.aborted
								? "Operation aborted"
								: `Tool "${toolName}" timed out after ${TOOL_TIMEOUT_MS / 1000}s — the result was discarded`,
						),
					),
				TOOL_ABORT_GRACE_MS,
			);
		};
		controller.signal.addEventListener("abort", onAbort, { once: true });
		if (controller.signal.aborted) onAbort(); // an already-aborted signal never fires listeners
		Promise.resolve()
			.then(() => run(controller.signal))
			.then(
				(v) => settle(() => resolve(v)),
				(e) => settle(() => reject(e)),
			);
	})
		.finally(cleanup);
}

/** The input-refinement failure: an isError result (pi's convention) the
 *  model can retry from, with the problems kept in `details` as data for
 *  the record and the UI. */
export function invalidInputResult(
	toolName: string,
	problems: string[],
): AppToolResult<{ tool: string; problems: string[] }> {
	return {
		content: [
			{
				type: "text",
				text: `Invalid tool input for tool "${toolName}":\n${problems.map((p) => `- ${p}`).join("\n")}`,
			},
		],
		isError: true,
		details: { tool: toolName, problems },
	};
}

/** A tool result that includes images (e.g. read on an image file);
 *  toToolResult maps it to pi's native text + image content parts.
 *  `images` carries base64 data + mimeType, as pi's ImageContent wants. */
export interface ImageFileResult {
	text: string;
	images?: { data: string; mimeType: string }[];
	/** The record-facing result (client rendering / persistence). */
	details?: unknown;
}

function isImageResult(v: unknown): v is ImageFileResult {
	return (
		typeof v === "object" && v !== null && "text" in v && typeof (v as ImageFileResult).text === "string"
	);
}

/** Strings pass verbatim to the model, objects as JSON; `details` carries
 *  the raw value the record's tool part reads. */
export function toToolResult(result: unknown): AppToolResult<unknown> {
	if (isImageResult(result)) {
		return {
			content: [
				{ type: "text", text: result.text },
				...(result.images ?? []).map((img) => ({
					type: "image" as const,
					data: img.data,
					mimeType: img.mimeType,
				})),
			],
			details: result.details ?? null,
		};
	}
	return {
		content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
		details: result,
	};
}

/** What a server-executed tool's body receives: the call id + the guard's
 *  combined signal (run abort + per-call timeout) for cooperative polling. */
export interface ToolExecuteContext {
	toolCallId: string;
	signal?: AbortSignal;
}

/** Build an AppTool execute from a tool body: the abort guard plus the
 *  shared result mapping. Question tools use questionResult instead. */
export function serverExecute<P extends TSchema>(
	toolName: string,
	schema: P,
	run: (input: Static<P>, ctx: ToolExecuteContext) => unknown,
): AppTool<any>["execute"] {
	// Typed loose (input: unknown) so it fits AppTool<any> under
	// strictFunctionTypes; `schema` is in the signature only so P infers at
	// the call site. The loop has already validated arguments against it.
	return async (toolCallId, input: unknown, signal) =>
		toToolResult(
			await runWithAbortGuard(toolName, (toolSignal) => run(input as Static<P>, { toolCallId, signal: toolSignal }), signal),
		);
}

/**
 * The synthetic question-tool result, never persisted: the record's tool
 * part keeps no output until the learner answers, and the answer re-enters
 * the next turn as this call's result. terminate: true ends the batch — pi
 * stops the loop only when every finalized result in the batch terminates.
 */
export function questionResult(): AppToolResult<null> {
	return {
		content: [
			{
				type: "text",
				text: "Question posed — the turn ends here; the learner's graded answer arrives as this call's result.",
			},
		],
		details: null,
		terminate: true,
	};
}
