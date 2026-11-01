/**
 * Durable background runs (pi-durable migration, unit C).
 *
 * Every background model loop runs as a real durable conversation in the
 * chat's own database: a child conversation with its own provider session
 * identity, the role's tools registered as durable tool tasks, and the role's
 * system prompt / model / thinking level stored in `pi.agent`. The run's
 * descriptor (role, safe model spec, prompt, caps, input and role state) is a
 * committed conversation document, so a process death leaves everything a
 * later process needs to reinstall the tools, prompt and Models binding
 * BEFORE the scheduler resumes the interrupted generation.
 *
 * The app-level half is the reattach watcher: after `harness.resume()` the job
 * runner calls `runBackgroundConversation` again with the same job id, which
 * finds the existing conversation by its durable index entry, re-submits the
 * same request id (a no-op for an already admitted input), waits for the
 * generation, folds the usage the harness committed, and returns the final
 * text. No graph write, spawn, or model call is duplicated by that re-entry.
 */

import { randomUUID } from "node:crypto";
import {
	defineDoc,
	defineExtension,
	GenerationTask,
	hook,
	ProviderDoc,
	UsageDoc,
	type AgentChange,
	type Conversation,
	type ConversationId,
	type EntryRecord,
	type Extension,
	type JsonObject,
	type ModelRef,
	type Submission,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { ModelRole } from "../../config.ts";
import { accumulateJobUsage, type JobUsage, type UsageStepLike } from "../core/contracts.ts";
import { createWebTools } from "../agent/tools/web.ts";
import { createPdfReadTools } from "../agent/tools/pdf-read.ts";
import { toRegistrations, type AppTool, type AppToolResult } from "../agent/tool-adapter.ts";
import { bindRunEngine, unbindRunEngine, type PiEngine } from "../agent/models.ts";
import { providerEventObserver } from "../agent/provider-events.ts";
import type { SearchProvider } from "../core/search.ts";
import { openChatRuntime, type ChatRuntime } from "../store/durable.ts";
import { registerJobAbort } from "../agent/subagents/aborts.ts";

/** The roles this module drives. */
export type BackgroundKind = "research";

/** Role state that must survive a restart; never a closure variable. */
export interface ResearchState {
	kind: "research";
	fetchedUrls: string[];
}

export type RunState = ResearchState;

/** The safe (secret-free) selection stored for recovery. */
export interface RunModel {
	provider: string;
	modelId: string;
	thinking?: string;
	/** Endpoint snapshot identity for a custom provider (never a credential). */
	baseUrl?: string;
}

export interface RunDescriptor {
	runId: string;
	jobId: string;
	chatId: string;
	kind: BackgroundKind;
	role: ModelRole;
	model: RunModel;
	/** The child conversation's provider session id; the Models router keys
	 *  this run's engine binding on it. */
	sessionId: string;
	maxTurns: number;
	systemPrompt: string;
	prompt: string;
	input: JsonObject;
	state: RunState;
	activity: string;
}

interface RunRef {
	conversationId: number;
	requestId: string;
	sessionId: string;
	status: "running" | "done" | "failed";
	kind: string;
}

interface RunsState {
	runs: JsonObject;
}

/** The chat database's index of background runs (session-scoped doc). */
export const BackgroundRunsDoc = defineDoc<JsonObject>({
	kind: "lh.bg-runs",
	version: 1,
	scope: "session",
	initial: () => ({ runs: {} }),
	checkpointWhen: () => false,
});

/** One background run's descriptor + role state (conversation-scoped). */
export const BackgroundRunDoc = defineDoc<JsonObject>({
	kind: "lh.bg-run",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({
		runId: "",
		jobId: "",
		chatId: "",
		kind: "research",
		role: "researcher",
		model: { provider: "", modelId: "" },
		sessionId: "",
		maxTurns: 0,
		systemPrompt: "",
		prompt: "",
		input: {},
		state: { kind: "research", fetchedUrls: [] },
		activity: "",
	}),
	checkpointWhen: () => false,
});

/** Host services the background runtime cannot import from the server
 *  composition root (the composition root configures them at module init). */
export interface BackgroundServices {
	/** Resolve the engine for a stored descriptor (settings + credential
	 *  snapshot read fresh; never persisted). */
	resolveEngine(descriptor: RunDescriptor): PiEngine | undefined;
	searchProvider(): SearchProvider | null;
}

let services: BackgroundServices | undefined;

export function configureBackgroundRuns(next: BackgroundServices): void {
	services = next;
}

function requireServices(): BackgroundServices {
	if (!services) throw new Error("background runs: host services not configured");
	return services;
}

/** What one role run needs at start. */
export interface BackgroundRunRequest {
	jobId: string;
	chatId: string;
	kind: BackgroundKind;
	role: ModelRole;
	/** The engine resolved and key-gated by the job runner for a FRESH run
	 *  (ignored when the durable index already has this job's run). */
	engine: PiEngine;
	maxTurns: number;
	systemPrompt: string;
	prompt: string;
	input?: JsonObject;
	attachments?: { pdfDir?: string };
	/** The runner's injected search seam (tests); production falls back to
	 *  the host's live provider. */
	search?: () => SearchProvider | null;
	/** The runner's job abort controller: firing it makes the runner's own
	 *  `abortSignal.aborted` guard see the kill, exactly like a pi loop. */
	abort?: AbortController;
	onActivity?: (line: string) => void;
	onUsage?: (usage: JobUsage) => void;
}

export interface BackgroundRunResult {
	text: string;
	state: RunState;
}

/** The role's tool registrations, rebuilt from the persisted descriptor. */
function roleTools(
	descriptor: RunDescriptor,
	search: () => SearchProvider | null,
): ToolRegistration[] {
	if (descriptor.kind === "research") {
		const tools: Record<string, AppTool<any>> = {
			...createWebTools(search),
		};
		const pdfDir = (descriptor.input as { pdfDir?: string }).pdfDir;
		if (typeof pdfDir === "string" && pdfDir.length > 0) {
			Object.assign(tools, createPdfReadTools(pdfDir));
		}
		return toRegistrations(tools).map((registration) =>
			withRunState(registration, descriptor.kind),
		);
	}
	throw new Error(`background runs: unsupported kind ${String(descriptor.kind)}`);
}

/** Persist role state BEFORE the tool result becomes visible: the wrapper
 *  returns the tool's result only after the state commit landed, so a crash
 *  cannot leave a committed deliverable missing its recovery state. */
function withRunState(registration: ToolRegistration, kind: BackgroundKind): ToolRegistration {
	return {
		...registration,
		execute: async (args, api, context) => {
			const result = await registration.execute(args as never, api, context);
			await api.commit(async (tx) => {
				const run = (await tx.doc(BackgroundRunDoc, api.conversationId)) as unknown as RunDescriptor;
				recordToolState(kind, run, registration.name, args, result);
				run.activity = activityLine(registration.name, args);
			}, context);
			return result;
		},
	};
}

function recordToolState(
	kind: BackgroundKind,
	run: RunDescriptor,
	toolName: string,
	args: unknown,
	result: Pick<AppToolResult, "isError">,
): void {
	if (kind !== "research") return;
	const state = run.state as ResearchState;
	const url = (args as { url?: unknown } | undefined)?.url;
	if (
		typeof url === "string" &&
		(toolName === "web_fetch" || toolName === "web_fetch_pdf") &&
		!result.isError &&
		!state.fetchedUrls.includes(url)
	) {
		state.fetchedUrls.push(url);
	}
}

function activityLine(toolName: string, args: unknown): string {
	const input = args as { query?: string; url?: string } | undefined;
	if (toolName === "web_search") return `web_search: "${input?.query ?? ""}"`;
	if (toolName === "web_fetch" || toolName === "web_fetch_pdf") {
		try {
			return `${toolName}: ${new URL(String(input?.url)).hostname}`;
		} catch {
			return toolName;
		}
	}
	return toolName;
}

/** The role extension: the tools plus the durable turn cap. The cap counts
 *  committed assistant entries, so it survives a restart without a closure
 *  counter. */
function roleExtension(
	conversation: Conversation,
	descriptor: RunDescriptor,
	search: () => SearchProvider | null,
): Extension {
	return defineExtension({
		name: `lh-bg-${descriptor.runId}`,
		tools: roleTools(descriptor, search),
		hooks: [
			hook(GenerationTask, {
				afterTools: async () => {
					const assistant = await countAssistantEntries(conversation);
					return assistant >= descriptor.maxTurns ? { terminate: true } : undefined;
				},
			}),
		],
	});
}

async function countAssistantEntries(conversation: Conversation): Promise<number> {
	let count = 0;
	let cursor: Record<string, unknown> | undefined;
	for (;;) {
		const page = await conversation.entries({ order: "ascending" }, 256, cursor as never, BACKGROUND_CONTEXT);
		for (const entry of page.items) {
			if ((entry.model?.[0] as { role?: string } | undefined)?.role === "assistant") count++;
		}
		if (!page.next) return count;
		cursor = page.next as Record<string, unknown>;
	}
}

async function readRunEntries(conversation: Conversation): Promise<EntryRecord[]> {
	const out: EntryRecord[] = [];
	let cursor: Record<string, unknown> | undefined;
	for (;;) {
		const page = await conversation.entries({ order: "ascending" }, 256, cursor as never, BACKGROUND_CONTEXT);
		out.push(...page.items);
		if (!page.next) return out;
		cursor = page.next as Record<string, unknown>;
	}
}

function isAssistant(entry: EntryRecord): boolean {
	return (entry.model?.[0] as { role?: string } | undefined)?.role === "assistant";
}

function assistantText(entries: readonly EntryRecord[]): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (!isAssistant(entry)) continue;
		const content = (entry.model?.[0] as { content?: Array<{ type?: string; text?: string }> }).content;
		if (!Array.isArray(content)) return "";
		const text = content
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("");
		if (text.length > 0) return text;
	}
	return "";
}

/** The money channel, rebuilt from committed assistant entries (aborted
 *  attempts excluded). Idempotent: every call sets the same totals. */
async function foldUsage(
	conversation: Conversation,
	model: string,
	onUsage: (usage: JobUsage) => void,
): Promise<JobUsage | undefined> {
	const entries = await readRunEntries(conversation);
	let total: JobUsage | undefined;
	for (const entry of entries) {
		const message = entry.model?.[0] as { role?: string; stopReason?: string; usage?: Usage } | undefined;
		if (message?.role !== "assistant" || !message.usage) continue;
		if (message.stopReason === "aborted") continue;
		total = accumulateJobUsage(total, model, usageStep(message.usage));
	}
	if (total) onUsage(total);
	return total;
}

function usageStep(usage: Usage): UsageStepLike {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		inputTokenDetails: { cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite },
		outputTokenDetails: usage.reasoning !== undefined ? { reasoningTokens: usage.reasoning } : undefined,
	};
}

async function readIndex(runtime: ChatRuntime): Promise<RunsState> {
	const state = (await runtime.harness.snapshot(BackgroundRunsDoc, BACKGROUND_CONTEXT)) as
		| RunsState
		| undefined;
	return { runs: state?.runs ?? {} };
}

async function updateIndex(runtime: ChatRuntime, jobId: string, patch: Partial<RunRef> | null): Promise<void> {
	await runtime.harness.commit(async (tx) => {
		const doc = await tx.doc(BackgroundRunsDoc);
		const runs = { ...((doc.runs ?? {}) as JsonObject) } as JsonObject;
		doc.runs = runs;
		if (patch === null) delete runs[jobId];
		else runs[jobId] = { ...(runs[jobId] as JsonObject), ...patch } as JsonObject;

	}, BACKGROUND_CONTEXT);
}

function agentChange(descriptor: RunDescriptor, extension: Extension | null): AgentChange {
	return {
		model: { provider: descriptor.model.provider, modelId: descriptor.model.modelId } satisfies ModelRef,
		...(descriptor.model.thinking
			? { thinkingLevel: descriptor.model.thinking as ModelThinkingLevel }
			: {}),
		...(extension ? { extensions: [extension] } : {}),
		instructions: descriptor.systemPrompt,
	};
}

function descriptorOf(
	request: BackgroundRunRequest,
	engine: PiEngine,
	sessionId: string,
	pdfDir: string | undefined,
): RunDescriptor {
	return {
		runId: randomUUID(),
		jobId: request.jobId,
		chatId: request.chatId,
		kind: request.kind,
		role: request.role,
		model: {
			provider: engine.model.provider,
			modelId: engine.model.id,
			...(engine.level ? { thinking: engine.level } : {}),
			...(engine.model.baseUrl ? { baseUrl: engine.model.baseUrl } : {}),
		},
		sessionId,
		maxTurns: request.maxTurns,
		systemPrompt: request.systemPrompt,
		prompt: request.prompt,
		input: { ...(request.input ?? {}), ...(pdfDir ? { pdfDir } : {}) } as JsonObject,
		state: { kind: "research", fetchedUrls: [] },
		activity: "starting",
	};
}

/** Create (or find) the run's conversation and descriptor in one commit. The
 *  index entry is the reattach key: a second process finds the same child
 *  instead of spawning a duplicate. */
async function ensureRun(
	runtime: ChatRuntime,
	request: BackgroundRunRequest,
	engine: PiEngine,
): Promise<{
	conversationId: ConversationId;
	ref: RunRef;
	descriptor: RunDescriptor;
	fresh: boolean;
}> {
	const index = await readIndex(runtime);

	const existing = index.runs[request.jobId] as unknown as RunRef | undefined;
	if (existing) {
		const conversation = await runtime.harness.conversation(idOf(existing.conversationId), BACKGROUND_CONTEXT);
		if (conversation) {
			const descriptor = (await runtime.harness.snapshot(
				BackgroundRunDoc,
				conversation.id,
				BACKGROUND_CONTEXT,
			)) as unknown as RunDescriptor | undefined;
			if (descriptor) {
				return { conversationId: conversation.id, ref: existing, descriptor, fresh: false };
			}
		}
		// The indexed transcript is gone: drop the stale entry and start over.
		await updateIndex(runtime, request.jobId, null);
	}
	const sessionId = randomUUID();
	const descriptor = descriptorOf(request, engine, sessionId, request.attachments?.pdfDir);
	const ref: RunRef = {
		conversationId: 0,
		requestId: `run:${request.jobId}`,
		sessionId,
		status: "running",
		kind: request.kind,
	};
	const conversationId = await runtime.root.commit(async (tx) => {
		const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
		(await tx.doc(ProviderDoc, created.id)).sessionId = sessionId;
		const doc = await tx.doc(BackgroundRunDoc, created.id);
		Object.assign(doc, descriptor);
		(await tx.doc(UsageDoc, created.id)).models = {};
		const runsDoc = await tx.doc(BackgroundRunsDoc);
		const runs = { ...((runsDoc.runs ?? {}) as JsonObject) } as JsonObject;
		runs[request.jobId] = { ...ref, conversationId: created.id } as unknown as JsonObject;
		runsDoc.runs = runs;
		ref.conversationId = created.id;
		return created.id;
	}, BACKGROUND_CONTEXT);
	return { conversationId, ref, descriptor, fresh: true };
}

function idOf(id: number): ConversationId {
	return id as ConversationId;
}

/** In-process single-flight per job: a dispatch and a recovery sweep that
 *  race share one attach instead of creating two conversations. */
const inflight = new Map<string, Promise<BackgroundRunResult>>();

/** Run (or reattach to) one background conversation and return its final
 *  text. Throws the run's failure so the job runner can build the kind's
 *  failure result. */
export function runBackgroundConversation(request: BackgroundRunRequest): Promise<BackgroundRunResult> {
	const running = inflight.get(request.jobId);
	if (running) return running;
	const started = attachBackgroundConversation(request);
	inflight.set(request.jobId, started);
	const clear = () => {
		if (inflight.get(request.jobId) === started) inflight.delete(request.jobId);
	};
	void started.then(clear, clear);
	return started;
}

async function attachBackgroundConversation(request: BackgroundRunRequest): Promise<BackgroundRunResult> {
	const runtime = await openChatRuntime(request.chatId);
	const { conversationId, ref, descriptor, fresh } = await ensureRun(runtime, request, request.engine);
	const conversation = await runtime.harness.conversation(conversationId, BACKGROUND_CONTEXT);
	if (!conversation) throw new Error(`background run ${descriptor.runId}: conversation missing`);
	const host = requireServices();
	const requestedModel = request.engine.model;
	const sameEndpoint =
		!descriptor.model.baseUrl || requestedModel.baseUrl === descriptor.model.baseUrl;
	const engine =
		requestedModel.provider === descriptor.model.provider &&
		requestedModel.id === descriptor.model.modelId &&
		sameEndpoint
			? request.engine
			: host.resolveEngine(descriptor);
	if (!engine) throw new Error(`no model available for background run ${descriptor.runId}`);
	bindRunEngine(descriptor.sessionId, engine, providerEventObserver(request.chatId, `job:${descriptor.role}`));
	const extension = roleExtension(conversation, descriptor, request.search ?? (() => host.searchProvider()));
	runtime.registry.install(extension);
	const abort = request.abort ?? new AbortController();
	abort.signal.addEventListener(
		"abort",
		() => {
			void conversation.abort(BACKGROUND_CONTEXT).catch(() => undefined);
		},
		{ once: true },
	);
	registerJobAbort(request.jobId, abort, () => {
		void conversation.abort(BACKGROUND_CONTEXT).catch((error) => {
			console.error(`[job ${request.jobId}] durable abort failed:`, error);
		});
	});
	let usageWatch: Awaited<ReturnType<ChatRuntime["harness"]["watchDoc"]>> | undefined;
	try {
		await conversation.configure(agentChange(descriptor, extension), BACKGROUND_CONTEXT);
		const model = `${engine.model.provider}:${engine.model.id}`;
		const reportUsage = async () =>
			foldUsage(conversation, model, request.onUsage ?? (() => undefined)).catch(() => undefined);
		usageWatch = await runtime.harness.watchDoc(UsageDoc, conversation.id, BACKGROUND_CONTEXT);
		usageWatch?.start(async () => {
			await reportUsage();
		});
		await reportUsage();
		const submission: Submission = await conversation.submit(
			{
				type: "input",
				content: descriptor.prompt as never,
				requestId: ref.requestId,
				whenBusy: "followUp",
			},
			BACKGROUND_CONTEXT,
		);
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		await reportUsage();
		if (settled.status !== "done") {
			// Surface the provider's own text (the old runSubagent threw the
			// error message verbatim; the job's failure brief quotes it).
			if ("detail" in settled && typeof settled.detail === "string" && settled.detail.length > 0) {
				throw new Error(settled.detail);
			}
			throw new Error("reason" in settled ? settled.reason : "no answer");
		}
		const entries = await readRunEntries(conversation);
		const lastAssistant = [...entries].reverse().find(isAssistant);
		const last = lastAssistant?.model?.[0] as { stopReason?: string; errorMessage?: string } | undefined;
		if (last?.stopReason === "error") throw new Error(last.errorMessage ?? "model error");
		const text = assistantText(entries);
		const state =
			((await runtime.harness.snapshot(BackgroundRunDoc, conversation.id, BACKGROUND_CONTEXT)) as
				| RunDescriptor
				| undefined)?.state ?? descriptor.state;
		await updateIndex(runtime, request.jobId, { status: "done" });
		return { text, state };
	} catch (error) {
		// A close is not a run failure: the run is still recoverable from its
		// committed checkpoint. Unwind like an abort so the caller does not
		// deliver a failure result a later process would contradict.
		if (runtime.closing) {
			const closed = new Error("runtime closed while the run was live");
			closed.name = "AbortError";
			throw closed;
		}
		await updateIndex(runtime, request.jobId, { status: "failed" }).catch(() => undefined);
		throw error;
	} finally {
		await usageWatch?.stop().catch(() => undefined);
		runtime.registry.uninstall(extension);
		unbindRunEngine(descriptor.sessionId);
	}
}

/** Reinstall the tools, prompt and Models binding of every live background
 *  run BEFORE the scheduler resumes it. Called from the chat runtime's open
 *  bootstrap (store/durable.ts) while scheduling is still off. */
export async function resumeBackgroundRuns(runtime: ChatRuntime): Promise<void> {
	const index = await readIndex(runtime);
	for (const [jobId, raw] of Object.entries(index.runs)) {
		const ref = raw as unknown as RunRef;
		if (ref.status !== "running") continue;
		const conversation = await runtime.harness.conversation(idOf(ref.conversationId), BACKGROUND_CONTEXT);
		if (!conversation) continue;
		const stored = (await runtime.harness.snapshot(
			BackgroundRunDoc,
			conversation.id,
			BACKGROUND_CONTEXT,
		)) as unknown as RunDescriptor | undefined;
		if (!stored) continue;
		const descriptor = stored;
		let host: BackgroundServices;
		try {
			host = requireServices();
		} catch {
			continue;
		}
		const engine = host.resolveEngine(descriptor);
		if (!engine) {
			console.error(`[job ${jobId}] cannot restore its model — recovery will refuse it`);
			continue;
		}
		bindRunEngine(descriptor.sessionId, engine, providerEventObserver(descriptor.chatId, `job:${descriptor.role}`));
		const extension = roleExtension(conversation, descriptor, () => host.searchProvider());
		runtime.registry.install(extension);
		await conversation.configure(agentChange(descriptor, extension), BACKGROUND_CONTEXT);
	}
}
