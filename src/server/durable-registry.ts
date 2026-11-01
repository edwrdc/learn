/**
 * THE CHAT CONVERSATION SETUP (pi-durable foreground runtime).
 *
 * One chat runtime (src/store/durable.ts) owns a registry. This module
 * installs the app's extension into it — the tool set for the transcript's
 * phase (prober / teacher / practice), the question-stop hook, and the
 * request filter (the hidden continuation input and the app's compaction
 * cut) — and configures the conversation's model, thinking level, prompt,
 * and enabled tools for the coming turn.
 *
 * It runs per turn: settings, the prompt-override switches, and the phase
 * seam are all read fresh. `configure()` writes only what changed.
 */

import { defineExtension, GenerationTask, hook, type EntryId, type ToolRegistration } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { graphToolsEnabled, type EffectiveSettings } from "../core/settings-resolution.ts";
import type { ChatStore, GraphStore, JobStore } from "../core/ports.ts";
import type { JobRecord } from "../core/contracts.ts";
import { hasProbeDone, type LhMessage } from "../core/native-messages.ts";
import { composeInstructions } from "../agent/teacher-agent.ts";
import { createProberTools, createTeacherTools } from "../agent/tools.ts";
import { practiceTools } from "../agent/tools/practice.ts";
import { toRegistrations } from "../agent/tool-adapter.ts";
import { bindRunEngine, type PiEngine } from "../agent/models.ts";
import { providerEventObserver } from "../agent/provider-events.ts";
import { claimToolCallId, collectToolCallIds } from "./pi/call-ids.ts";
import { activeCompactionOf, keptIndexFor } from "../core/compaction.ts";
import {
	CONTINUATION_KIND,
	modelTextOf,
	type ChatRuntime,
} from "../store/durable.ts";
import type { DemoInput, PdfInput, ResearchInput, VisualInput } from "../agent/tools/jobs.ts";

/** What the composition root hands the setup: the stores and the seams the
 *  tools close over (the same wiring the old per-request construction used). */
export interface ConversationDeps {
	chatStore: ChatStore;
	graphStore: GraphStore;
	jobStore: JobStore;
	spawn: (job: JobRecord, input: ResearchInput | DemoInput | VisualInput | PdfInput) => void;
	deliver: (steer: LhMessage) => void;
	searchAvailable: () => boolean;
	graphNodes: () => ReadonlyArray<{ id: string; name: string }>;
}

export type ChatPhase = "probe" | "teach" | "practice";

/** The transcript's phase seam (the old construction branch): practice
 *  sessions are practice from turn one; otherwise a probe_done call means
 *  the probe concluded and the teacher takes over. */
export function chatPhase(messages: readonly LhMessage[], kind: string | undefined): ChatPhase {
	if (kind === "practice") return "practice";
	return hasProbeDone(messages) ? "teach" : "probe";
}

/** The app's tool set for one phase, as durable registrations. */
function toolsFor(
	phase: ChatPhase,
	chatId: string,
	deps: ConversationDeps,
	effective: EffectiveSettings,
): ToolRegistration[] {
	if (phase === "practice") {
		return toRegistrations(
			practiceTools({
				chatId,
				chatStore: deps.chatStore,
				graphNodes: deps.graphNodes,
				jobs: {
					chatId,
					jobStore: deps.jobStore,
					spawn: deps.spawn,
					searchAvailable: deps.searchAvailable,
				},
				...(graphToolsEnabled(effective) ? { graph: { chatStore: deps.chatStore, graphStore: deps.graphStore } } : {}),
			}),
		);
	}
	if (phase === "teach") {
		return toRegistrations(
			createTeacherTools(
				{
					chatId,
					chatStore: deps.chatStore,
					jobStore: deps.jobStore,
					spawn: deps.spawn,
					searchAvailable: deps.searchAvailable,
				},
				effective.agent.tools,
			),
		);
	}
	return toRegistrations(
		createProberTools(
			{
				chatId,
				chatStore: deps.chatStore,
				deliver: (steer) => deps.deliver(steer),
				jobStore: deps.jobStore,
				spawn: deps.spawn,
				searchAvailable: deps.searchAvailable,
				...(graphToolsEnabled(effective) ? { graphStore: deps.graphStore } : {}),
			},
			effective.agent.tools,
		),
	);
}

/** The wire form of one record message (what the provider saw for it). */
function wireOf(message: LhMessage): Message | null {
	if (message.role === "custom") {
		const text = modelTextOf(message);
		return text === null || text === ""
			? null
			: { role: "user", content: [{ type: "text", text }], timestamp: message.timestamp };
	}
	const { id: _id, ...native } = message;
	return native as Message;
}

/** The round-wide question stop (the patched afterTools seam): a round that
 *  called a question tool ends the run unless one of those calls failed
 *  authoring validation (the model must retry inside the same turn). The stop
 *  PARKS the inbox: a steer queued behind the question must not start another
 *  model call before the learner answers. The answer's continuation submit
 *  places the parked inputs in the same run that reacts to the answer. */
function questionStopHook(chatId: string) {
	return hook(GenerationTask, {
		afterTools: async (assistantId, resultIds, api, context) => {
			const assistant = await api.entry(assistantId, context);
			const content = (assistant?.model?.[0] as { content?: Array<{ type?: string; id?: string; name?: string }> })
				?.content;
			if (!Array.isArray(content)) return;
			const questionCallIds = content
				.filter((block) => block.type === "toolCall" && (QUESTION_TOOLS as readonly string[]).includes(block.name ?? ""))
				.map((block) => block.id);
			if (questionCallIds.length === 0) return;
			for (const id of resultIds) {
				const entry = await api.entry(id, context);
				const message = entry?.model?.[0] as
					| { role?: string; toolCallId?: string; isError?: boolean }
					| undefined;
				if (message?.role !== "toolResult" || !questionCallIds.includes(message.toolCallId)) continue;
				if (message.isError) {
					console.info(`[chat ${chatId}] question round continues — ${message.toolCallId} failed validation`);
					return;
				}
			}
			return { terminate: true, parkInputs: true };
		},
	});
}

/** Tool-call id hygiene: some providers reset ids per
 *  response (`call_0`, `call_1`, …), so a one-call-per-turn session names
 *  every call `call_0`. The app keys the view, the dock, answer routing, and
 *  option shuffles on the id — the collision corrupts all of them at once.
 *  Rewriting happens ONCE per terminal response, before classification, so
 *  the call, its result entry, the record, and the next request agree. */
function uniqueCallIdsHook(used: Set<string>) {
	return hook(GenerationTask, {
		afterResponse: (message) => {
			if (message.role !== "assistant") return;
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const mapped = claimToolCallId(block.id, used);
				if (mapped !== block.id) block.id = mapped;
			}
		},
	});
}

/** The app's request shaping, at the one boundary durable offers: the hidden
 *  continuation INPUT never reaches the provider, and an active compaction
 *  cut projects [summary] + [messages from the kept boundary onward] — the
 *  same context the provider receives. The cut is resolved per turn
 *  (the model-facing half of the app's compaction contract); durable-owned
 *  compaction replaces it in the compaction unit. */
function requestFilterHook(runtime: ChatRuntime, cut: { kept: Message; head: Message } | null) {
	return hook(GenerationTask, {
		beforeRequest: async (request, api, context) => {
			// The hook carries no request cutoff; the generation checkpoint does.
			const task = await runtime.harness.getTask(api.taskId, context);
			const checkpoint = task?.state.checkpoint as { phase?: string; cutoff?: EntryId } | undefined;
			const view = await runtime.root.context(
				context,
				checkpoint?.phase === "request" && checkpoint.cutoff !== undefined
					? { at: checkpoint.cutoff }
					: undefined,
			);
			// Tool results are ordered within a round; user messages keep their order.
			const hidden: boolean[] = [];
			view.entries.forEach((entry, index) => {
				for (const message of view.contributions[index] ?? []) {
					if (message.role === "user") hidden.push(entry.kind === CONTINUATION_KIND);
				}
			});
			let ordinal = 0;
			const filtered = request.messages.filter((message) =>
				message.role === "user" ? hidden[ordinal++] !== true : true,
			);
			if (cut === null) return { messages: filtered };
			const markerText = (cut.head.content as Array<{ text?: string }>)[0]?.text;
			const withoutMarker = filtered.filter(
				(message) =>
					!(
						message.role === "user" &&
						Array.isArray(message.content) &&
						message.content.length === 1 &&
						(message.content[0] as { text?: string }).text === markerText
					),
			);
			const at = withoutMarker.findIndex(
				(message) => JSON.stringify(message) === JSON.stringify(cut.kept),
			);
			if (at < 0) return { messages: withoutMarker };
			return { messages: [cut.head, ...withoutMarker.slice(at)] };
		},
	});
}

/** What the caller may override for one turn: a test-authored tool registry
 *  (the loop/protocol suites drive narrow tool sets) and the phase a
 *  RECOVERED run was admitted under (see ChatPhase). */
export interface PrepareOptions {
	tools?: Record<string, unknown>;
	phase?: ChatPhase;
}

/** Install (or replace) the app extension and configure the conversation for
 *  the coming turn. `messages` is the transcript the turn will run on. */
export async function prepareConversation(
	runtime: ChatRuntime,
	chatId: string,
	messages: readonly LhMessage[],
	kind: string | undefined,
	engine: PiEngine,
	effective: EffectiveSettings,
	deps: ConversationDeps,
	options?: PrepareOptions,
): Promise<void> {
	const phase = options?.phase ?? chatPhase(messages, kind);
	const active = activeCompactionOf(messages);
	const kept = active ? keptIndexFor(messages, active) : -1;
	const keptWire = kept >= 0 ? wireOf(messages[kept]!) : null;
	const cut =
		active && keptWire
			? {
					kept: keptWire,
					head: {
						role: "user" as const,
						content: [{ type: "text" as const, text: active.content }],
						timestamp: active.timestamp,
					},
				}
			: null;
	const extension = defineExtension({
		name: "lh",
		tools: options?.tools ? toRegistrations(options.tools) : toolsFor(phase, chatId, deps, effective),
		hooks: [
			questionStopHook(chatId),
			uniqueCallIdsHook(new Set(collectToolCallIds(messages))),
			requestFilterHook(runtime, cut),
		],
	});
	runtime.registry.install(extension);
	const engineKind = phase === "practice" ? "practice" : phase === "probe" ? "prober" : "teacher";
	// The root conversation's provider session id IS the public chat id
	// (store/durable.ts init), so binding the chat id binds this turn's
	// engine for its requests only — a background child never shares it.
	bindRunEngine(chatId, engine, providerEventObserver(chatId, engineKind));
	await runtime.root.configure(
		{
			model: { provider: engine.model.provider, modelId: engine.model.id },
			...(engine.level ? { thinkingLevel: engine.level as never } : {}),
			instructions: composeInstructions(engineKind, effective.agent.prompts),
			// The registry IS the enabled set (the tool toggles already
			// filtered it); the stored filter stays unset so it never widens.
			tools: null,
			// The registry also holds live background children (jobs, extraction,
			// compaction); the foreground selects only its own extension.
			extensions: [extension],
		},
		BACKGROUND_CONTEXT,
	);
}
