/**
 * THE ONE ADAPTER from the app's tool shape to a pi-durable ToolRegistration.
 *
 * Tools stay authored as they are (name, description, TypeBox parameters,
 * `prepareArguments`, a guarded `execute(toolCallId, args, signal)` returning
 * the native result shape) — rewriting every tool body for a different call
 * signature would buy nothing. This module owns the translation: the durable
 * `execute(args, api, context)` call, the result mapping (`content` →
 * `output`, `terminate` → `control.terminate`), and the replay policy.
 */

import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { Static, TSchema } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";

/** The result shape the app's tools return. */
export interface AppToolResult<D = unknown> {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	details?: D;
	isError?: boolean;
	terminate?: boolean;
	usage?: Usage;
}

/** The app's tool shape: everything a registration needs, nothing else. */
export interface AppTool<P extends TSchema = TSchema> {
	name: string;
	label?: string;
	description: string;
	parameters: P;
	prepareArguments?(args: unknown): Static<P>;
	executionMode?: "parallel" | "sequential";
	execute(toolCallId: string, args: Static<P>, signal?: AbortSignal): Promise<AppToolResult>;
}

/** Tools that never mutate app state, so a crash mid-call may rerun them.
 *  Everything else (`plan_init`, `probe_done`'s handoff, job dispatch, the
 *  fs readers' shared position state) stays unsafe on purpose: a replay must
 *  never duplicate a tree write or queue two wakes. */
const REPLAY_SAFE = new Set(["quiz", "explain", "ask_user_question", "problem", "conclude"]);

/** One app tool as a durable registration. */
export function toRegistration(tool: AppTool<any>): ToolRegistration {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		executionMode: tool.executionMode,
		replay: REPLAY_SAFE.has(tool.name) ? "safe" : "unsafe",
		...(tool.prepareArguments
			? { prepareArguments: (args: unknown) => tool.prepareArguments!(args) as never }
			: {}),
		execute: async (args: never, api, context) => {
			const result = await tool.execute(api.callId, args, context.abortSignal);
			return {
				output: result.content as never,
				details: (result.details ?? null) as never,
				...(result.isError ? { isError: true as const } : {}),
				...(result.terminate ? { control: { terminate: true as const } } : {}),
				...(result.usage ? { usage: result.usage } : {}),
			};
		},
	};
}

/** A whole registry record (the factories' shape) as registrations. */
export function toRegistrations(tools: Record<string, unknown>): ToolRegistration[] {
	return Object.values(tools).map((tool) => toRegistration(tool as AppTool<any>));
}
