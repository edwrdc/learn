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
import { isQuestionTool } from "../tools/model/index.ts";
import { graphToolsEnabled, type EffectiveSettings } from "../settings/model/index.ts";
import type { ChatStore } from "./model/ports.ts";
import type { GraphStore } from "../graph/model/index.ts";
import type { JobStore } from "../jobs/model/index.ts";
import type { JobRecord } from "../jobs/model/index.ts";
import { compactionCutOf, type CompactionCut, type LhMessage } from "./model/transcript.ts";
import { agentFor, chatPhase, type ChatPhase } from "./model/phases.ts";
import { composeInstructions } from "./agents.ts";
import { createProberTools, createTeacherTools } from "./tools/registry.ts";
import { practiceTools } from "./tools/practice.ts";
import { toRegistrations } from "../tools/index.ts";
import { bindRunEngine, type PiEngine } from "../platform/index.ts";
import { providerEventObserver } from "../platform/index.ts";
import { claimToolCallId, collectToolCallIds } from "./pi/call-ids.ts";
import { CONTINUATION_KIND, projectTranscript, type ChatRuntime } from "./durable.ts";
import type { DemoInput, PdfInput, ResearchInput, VisualInput } from "../jobs/index.ts";

/** What the composition root hands the setup: the stores and the seams the
 *  tools close over (the same wiring the old per-request construction used). */
export interface ConversationDeps {
	chatStore: ChatStore;
	graphStore: GraphStore;
	jobStore: JobStore;
	spawn: (job: JobRecord, input: ResearchInput | DemoInput | VisualInput | PdfInput) => void;
	deliver: (chatId: string, steer: LhMessage) => void;
	searchAvailable: () => boolean;
	graphNodes: () => ReadonlyArray<{ id: string; name: string }>;
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
				deliver: (steer) => deps.deliver(chatId, steer),
				jobStore: deps.jobStore,
				spawn: deps.spawn,
				searchAvailable: deps.searchAvailable,
				...(graphToolsEnabled(effective) ? { graphStore: deps.graphStore } : {}),
			},
			effective.agent.tools,
		),
	);
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
				.filter((block) => block.type === "toolCall" && isQuestionTool(block.name ?? ""))
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
 *  continuation input never reaches the provider, and an active compaction
 *  cut sends the system prompt, the summary head, then the entries from the
 *  kept message onward (native automatic compaction is disabled).
 *
 *  Request messages are matched to their entries by order: pi-durable
 *  reorders only tool results (each after its call) and moves the system
 *  prompt to the front, so every other message comes from the next entry
 *  that contributed one. */
function requestFilterHook(runtime: ChatRuntime, cut: CompactionCut | null) {
	return hook(GenerationTask, {
		beforeRequest: async (request, api, context) => {
			try {
				// The hook carries no request cutoff; the generation checkpoint does.
				const task = await runtime.harness.getTask(api.taskId, context);
				const checkpoint = task?.state.checkpoint as { phase?: string; cutoff?: EntryId } | undefined;
				if (checkpoint?.phase !== "request" || checkpoint.cutoff === undefined) {
					throw new Error(`[chat ${runtime.chatId}] no request checkpoint for task ${api.taskId}`);
				}
				const view = await runtime.root.context(context, { at: checkpoint.cutoff });
				const ordered = (role: string) => role !== "toolResult" && role !== "system";
				const owners: number[] = [];
				view.entries.forEach((_, index) => {
					for (const message of view.contributions[index] ?? []) if (ordered(message.role)) owners.push(index);
				});
				const { entryOf } = projectTranscript(view.entries);
				const indexOf = (messageId: string) => {
					const entry = entryOf.get(messageId);
					return entry === undefined ? -1 : view.entries.findIndex((candidate) => candidate.id === entry);
				};
				const keptAt = cut ? indexOf(cut.keptId) : -1;
				const markerAt = cut ? indexOf(cut.markerId) : -1;
				const active = keptAt >= 0;
				const carried: Message[] = [];
				const kept: Message[] = [];
				let ordinal = 0;
				let owner = -1;
				for (const message of request.messages) {
					if (ordered(message.role)) owner = owners[ordinal++] ?? owner;
					if (message.role === "user" && view.entries[owner]?.kind === CONTINUATION_KIND) continue;
					if (!active) {
						kept.push(message);
						continue;
					}
					if (owner === markerAt && message.role === "user") continue;
					if (owner >= keptAt) kept.push(message);
					else if (message.role === "system") carried.push(message);
				}
				return { messages: active ? [...carried, cut!.head, ...kept] : kept };
			} catch (error) {
				// Hook errors are non-fatal; abort the generation before rethrowing.
				const signal = (api as unknown as { signal: AbortSignal }).signal;
				void runtime.harness.abortTask(api.taskId, context).catch(() => undefined);
				if (!signal.aborted) {
					await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				}
				throw error;
			}
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
	const extension = defineExtension({
		name: "lh",
		tools: options?.tools ? toRegistrations(options.tools) : toolsFor(phase, chatId, deps, effective),
		hooks: [
			questionStopHook(chatId),
			uniqueCallIdsHook(new Set(collectToolCallIds(messages))),
			requestFilterHook(runtime, compactionCutOf(messages)),
		],
	});
	runtime.registry.install(extension);
	const agent = agentFor(phase);
	// The root conversation's provider session id IS the public chat id
	// (store/durable.ts init), so binding the chat id binds this turn's
	// engine for its requests only — a background child never shares it.
	bindRunEngine(chatId, engine, providerEventObserver(chatId, agent));
	await runtime.root.configure(
		{
			model: { provider: engine.model.provider, modelId: engine.model.id },
			...(engine.level ? { thinkingLevel: engine.level as never } : {}),
			instructions: composeInstructions(agent, effective.agent.prompts),
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
