/**
 * Durable background runs (pi-durable migration, unit C).
 *
 * Every background model loop runs as a real durable conversation in the
 * owning chat's database: a child conversation with its own provider session
 * identity, the role's tools registered as durable tool tasks, and the role's
 * system prompt / model / thinking level stored in `pi.agent`. The run's
 * descriptor (role, safe model spec, prompt, caps, input and role state) is a
 * committed conversation document, so a process death leaves everything a
 * later process needs to reinstall the tools, prompt and Models binding
 * BEFORE the scheduler resumes the interrupted generation.
 *
 * Roles: the job roles (research, demo, visual, PDF), the extraction submit
 * stages (extractor, auditor; a notes source owns its own database) and the
 * compaction summarizer. Role state is the discriminated `RunState` union in
 * agent/subagents/durable-run.ts; tools commit their state BEFORE their
 * result, and the after-tools / on-yield hooks own the role's turn cap,
 * image-in-the-loop messages and the PDF nudge.
 *
 * The app-level half is the reattach watcher: after `harness.resume()` the
 * caller runs the same run key again, which finds the existing conversation
 * by its durable index entry, re-submits the same request id (a no-op for an
 * already admitted input), waits for the generation, folds the usage the
 * harness committed, and returns the final text. No graph write, spawn, or
 * model call is duplicated by that re-entry.
 */

import { JOB_KINDS } from "../tools/model/index.ts";
import { processState } from "../platform/model/index.ts";
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
	type EntryId,
	type EntryRecord,
	type Extension,
	type HookApi,
	type JsonObject,
	type ModelRef,
	type Submission,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { accumulateJobUsage, type JobUsage } from "./model/types.ts";
import { usageFromPi } from "../session/model/index.ts";
import { auditorGraphTools, AUDIT_TOOL, FINDINGS_TOOL, submitRoleTool, type GraphToolContext, type SubmitRunInput } from "../graph/index.ts";
import { toRegistrations } from "../tools/index.ts";
import { bindRunEngine, modelSnapshot, runsSnapshot, unbindRunEngine, type PiEngine } from "../platform/index.ts";
import { modelKey } from "../settings/model/index.ts";
import { providerEventObserver } from "../platform/index.ts";
import { openChatRuntime, type ChatRuntime } from "../session/index.ts";
import {
	backgroundServices,
	RunFailure,
	type BackgroundKind,
	type BackgroundRunRequest,
	type BackgroundRunResult,
	type RoleMessageContent,
	type RoleStateIo,
	type RunDescriptor,
	type RunState,
	type RunStep,
	type SubmitRunState,
} from "./durable-run.ts";
import { JOB_ROLES } from "./roles/registry.ts";
import { roleHeadless, type DurableRole, type RoleHost, type RoleRun } from "./roles/role.ts";
import { stores } from "../stores.ts";

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
	}),
	checkpointWhen: () => false,
});

/** The extraction stages: one validated submit ends the run; the auditor
 *  also explores the live graph. */
function submitRole(kind: "extract" | "audit"): DurableRole<SubmitRunState> {
	return {
		initialState: () => ({ kind, submitted: null }),
		// Read at run time: graph and jobs import each other.
		get submitTool() {
			return kind === "audit" ? AUDIT_TOOL : FINDINGS_TOOL;
		},
		tools(run) {
			const submit = submitRoleTool(run.input as unknown as SubmitRunInput, run.state);
			return kind === "audit" ? { ...auditorGraphTools(run.host.graph()), [submit.name]: submit } : { [submit.name]: submit };
		},
	};
}

const DURABLE_ROLES: Record<BackgroundKind, DurableRole<any>> = {
	...JOB_ROLES,
	extract: submitRole("extract"),
	audit: submitRole("audit"),
	compact: { initialState: () => ({ kind: "compact" }), tools: () => ({}) },
};

function productionGraph(): GraphToolContext {
	return { chatStore: stores.chatStore, graphStore: stores.graphStore };
}

function roleHost(request: BackgroundRunRequest | undefined): RoleHost {
	const services = backgroundServices();
	return {
		headless: roleHeadless(request?.headless),
		search: request?.search ?? (() => services.searchProvider?.() ?? null),
		graph: () => request?.graph ?? services.graphContext?.() ?? productionGraph(),
		onActivity: request?.onActivity,
	};
}

async function readDescriptor(runtime: ChatRuntime, conversation: Conversation): Promise<RunDescriptor> {
	const run = (await runtime.harness.snapshot(BackgroundRunDoc, conversation.id, BACKGROUND_CONTEXT)) as
		| RunDescriptor
		| undefined;
	if (!run) throw new Error(`background run: descriptor missing on conversation ${conversation.id}`);
	return run;
}

/** The persisted role state as a read/modify handle; an appended user
 *  message lands in the same commit as the state change. */
function roleState<S extends RunState>(runtime: ChatRuntime, conversation: Conversation): RoleStateIo<S> {
	return {
		read: async () => (await readDescriptor(runtime, conversation)).state as S,
		update: async (mutate, append) => {
			await conversation.commit(async (tx) => {
				const run = (await tx.doc(BackgroundRunDoc, conversation.id)) as unknown as RunDescriptor;
				mutate(run.state as S);
				if (append !== undefined) {
					await tx.appendEntry(conversation.id, {
						kind: "lh.bg-image",
						model: [{ role: "user", content: append as never, timestamp: Date.now() }],
					});
				}
			}, BACKGROUND_CONTEXT);
		},
	};
}

function roleRun(
	runtime: ChatRuntime,
	conversation: Conversation,
	descriptor: RunDescriptor,
	host: RoleHost,
): RoleRun<RunState> {
	return {
		input: descriptor.input,
		maxTurns: descriptor.maxTurns,
		state: roleState(runtime, conversation),
		host,
		turnsTaken: () => countAssistantEntries(conversation),
		markCapped: () => markCapped(conversation),
		hasUserMessage: async (text) =>
			(await readRunEntries(conversation)).some((entry) => {
				const message = entry.model?.[0] as { role?: string; content?: unknown } | undefined;
				return message?.role === "user" && message.content === text;
			}),
	};
}

/** The role extension: the role's tools, the durable turn cap and the
 *  role's hooks. The cap counts committed assistant entries, so it survives
 *  a restart without a closure counter. */
function roleExtension(
	runtime: ChatRuntime,
	conversation: Conversation,
	descriptor: RunDescriptor,
	host: RoleHost,
): Extension {
	const role = DURABLE_ROLES[descriptor.kind];
	const run = roleRun(runtime, conversation, descriptor, host);
	return defineExtension({
		name: `lh-bg-${descriptor.runId}`,
		tools: toRegistrations(role.tools(run)),
		hooks: [
			hook(GenerationTask, {
				afterTools: async (_assistant, results, api, context) => {
					await role.afterTools?.(run);
					if (role.submitTool && (await cleanResultInRound(role.submitTool, results, api, context))) {
						return { terminate: true };
					}
					if ((await countAssistantEntries(conversation)) >= descriptor.maxTurns) {
						await markCapped(conversation);
						return { terminate: true };
					}
					return undefined;
				},
				onYield: async () => {
					const next: RoleMessageContent | undefined = await role.onYield?.(run);
					return next === undefined ? undefined : { continue: next };
				},
			}),
		],
	});
}

/** A round that carries a schema-valid, accepted submit ends the run even
 *  when the model batched other calls beside it. */
async function cleanResultInRound(
	toolName: string,
	results: readonly EntryId[],
	api: HookApi,
	context: Context,
): Promise<boolean> {
	for (const id of results) {
		const entry = await api.entry(id, context);
		const message = entry?.model?.[0] as { role?: string; toolName?: string; isError?: boolean } | undefined;
		if (message?.role === "toolResult" && message.toolName === toolName && !message.isError) return true;
	}
	return false;
}

async function markCapped(conversation: Conversation): Promise<void> {
	await conversation.commit(async (tx) => {
		const run = (await tx.doc(BackgroundRunDoc, conversation.id)) as unknown as RunDescriptor;
		run.capped = true;
	}, BACKGROUND_CONTEXT);
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
		total = accumulateJobUsage(total, model, usageFromPi(message.usage));
	}
	if (total) onUsage(total);
	return total;
}

/** A settled-submission stand-in for an abort that lands around admission. */
function abortedSettlement(signal: AbortSignal | undefined): Promise<{
	status: "unanswered";
	reason: "aborted";
}> {
	return new Promise((resolve) => {
		const done = () => resolve({ status: "unanswered", reason: "aborted" });
		if (signal?.aborted) done();
		else signal?.addEventListener("abort", done, { once: true });
	});
}

/** Every completed assistant step, oldest first (aborted attempts excluded). */
function runSteps(entries: readonly EntryRecord[]): RunStep[] {
	const steps: RunStep[] = [];
	for (const entry of entries) {
		const message = entry.model?.[0] as
			| {
					role?: string;
					provider?: string;
					model?: string;
					stopReason?: string;
					usage?: Usage;
					content?: Array<{ type?: string; name?: string }>;
				}
			| undefined;
		if (message?.role !== "assistant" || message.stopReason === "aborted" || !message.usage) continue;
		steps.push({
			step: steps.length + 1,
			model: modelKey(message.provider ?? "", message.model ?? ""),
			usage: message.usage,
			finishReason: message.stopReason ?? "",
			tools:
				(message.content ?? [])
					.filter((block) => block.type === "toolCall")
					.map((block) => block.name)
					.join(", ") || "(none)",
		});
	}
	return steps;
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
		if (patch === null) delete runs[jobId];
		else runs[jobId] = { ...(runs[jobId] as JsonObject), ...patch } as JsonObject;
		// Assign LAST: the draft materializes the value at assignment, so a
		// mutation after it would be lost.
		doc.runs = runs;
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
		model: modelSnapshot(engine),
		sessionId,
		maxTurns: request.maxTurns,
		systemPrompt: request.systemPrompt,
		prompt: request.prompt,
		input: {
			...(request.input ?? {}),
			...(pdfDir ? { pdfDir } : {}),
		} as JsonObject,
		state: DURABLE_ROLES[request.kind].initialState(),
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
	if (existing && existing.status !== "failed") {
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
	}
	// A stale or failed entry is replaced: a failed attempt must be able to
	// retry on its next entry instead of re-reading a settled failure.
	if (index.runs[request.jobId]) await updateIndex(runtime, request.jobId, null);
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

/** In-process single-flight per run: a dispatch and a recovery sweep that
 *  race share one attach instead of creating two conversations. */

/** Run (or reattach to) one background conversation and return its final
 *  text. Throws the run's failure so the caller can build the kind's
 *  failure result. */
export function runBackgroundConversation(request: BackgroundRunRequest): Promise<BackgroundRunResult> {
	const key = `${request.chatId}\u0000${request.jobId}`;
	const inflight = processState("backgroundInflight", () => new Map<string, Promise<BackgroundRunResult>>());
	const running = inflight.get(key);
	if (running) return running;
	const started = attachBackgroundConversation(request);
	inflight.set(key, started);
	const clear = () => {
		if (inflight.get(key) === started) inflight.delete(key);
	};
	void started.then(clear, clear);
	return started;
}

async function attachBackgroundConversation(request: BackgroundRunRequest): Promise<BackgroundRunResult> {
	const runtime = await openChatRuntime(request.chatId);
	const { conversationId, ref, descriptor } = await ensureRun(runtime, request, request.engine);
	const conversation = await runtime.harness.conversation(conversationId, BACKGROUND_CONTEXT);
	if (!conversation) throw new Error(`background run ${descriptor.runId}: conversation missing`);
	const services = backgroundServices();
	const engine = runsSnapshot(request.engine, descriptor.model) ? request.engine : services.resolveEngine?.(descriptor);
	if (!engine) throw new Error(`no model available for background run ${descriptor.runId}`);
	bindRunEngine(descriptor.sessionId, engine, providerEventObserver(descriptor.chatId, `job:${descriptor.role}`));
	const extension = roleExtension(runtime, conversation, descriptor, roleHost(request));
	runtime.registry.install(extension);
	const signal = request.signal;
	const abortConversation = () => {
		void conversation.abort(BACKGROUND_CONTEXT).catch((error) => {
			console.error(`[run ${request.jobId}] durable abort failed:`, error);
		});
	};
	if (signal?.aborted) abortConversation();
	else signal?.addEventListener("abort", abortConversation, { once: true });
	let usageWatch: Awaited<ReturnType<ChatRuntime["harness"]["watchDoc"]>> | undefined;
	try {
		await conversation.configure(agentChange(descriptor, extension), BACKGROUND_CONTEXT);
		const model = modelKey(engine.model.provider, engine.model.id);
		let emittedSteps = 0;
		const reportProgress = async () => {
			await foldUsage(conversation, model, request.onUsage ?? (() => undefined)).catch(() => undefined);
			if (!request.onStep) return;
			const steps = runSteps(await readRunEntries(conversation)).slice(emittedSteps);
			for (const step of steps) request.onStep(step);
			emittedSteps += steps.length;
		};
		usageWatch = await runtime.harness.watchDoc(UsageDoc, conversation.id, BACKGROUND_CONTEXT);
		usageWatch?.start(async () => {
			await reportProgress();
		});
		await reportProgress();
		const submission: Submission = await conversation.submit(
			{
				type: "input",
				content: descriptor.prompt as never,
				requestId: ref.requestId,
				whenBusy: "followUp",
			},
			BACKGROUND_CONTEXT,
		);
		// An abort can win the race before the input is placed (the withdrawn
		// submission never settles): race the wait so the run still unwinds.
		const settled = await Promise.race([
			submission.wait(BACKGROUND_CONTEXT),
			abortedSettlement(signal),
		]);
		await reportProgress();
		if (settled.status !== "done") {
			if (signal?.aborted) {
				const stopped = new Error("aborted");
				stopped.name = "AbortError";
				throw stopped;
			}
			// Surface the provider's own text, verbatim: the job's failure
			// brief quotes it.
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
		const stored = (await runtime.harness.snapshot(BackgroundRunDoc, conversation.id, BACKGROUND_CONTEXT)) as
			| RunDescriptor
			| undefined;
		await updateIndex(runtime, request.jobId, { status: "done" });
		return {
			text,
			state: stored?.state ?? descriptor.state,
			capped: stored?.capped === true,
			steps: runSteps(entries),
		};
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
		if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
			const stopped = new Error(error instanceof Error ? error.message : String(error));
			stopped.name = "AbortError";
			throw stopped;
		}
		// The caller's failure result may quote what the run had reached (the
		// PDF brief's page sets).
		const stored = (await runtime.harness
			.snapshot(BackgroundRunDoc, conversation.id, BACKGROUND_CONTEXT)
			.catch(() => undefined)) as RunDescriptor | undefined;
		throw new RunFailure(error instanceof Error ? error.message : String(error), stored?.state);
	} finally {
		await usageWatch?.stop().catch(() => undefined);
		signal?.removeEventListener("abort", abortConversation);
		runtime.registry.uninstall(extension);
		unbindRunEngine(descriptor.sessionId);
	}
}

/** Abort a recovered run whose app-level loop has not reattached: there is
 *  no in-process AbortController to fire yet, so the child conversation's
 *  own abort is the kill switch. Marks the index failed so a later sweep
 *  does not reattach a run the learner stopped. */
export async function abortBackgroundRun(chatId: string, jobId: string): Promise<boolean> {
	const runtime = await openChatRuntime(chatId);
	const index = await readIndex(runtime);
	const ref = index.runs[jobId] as unknown as RunRef | undefined;
	if (!ref || ref.status !== "running") return false;
	const conversation = await runtime.harness.conversation(idOf(ref.conversationId), BACKGROUND_CONTEXT);
	if (!conversation) return false;
	await conversation.abort(BACKGROUND_CONTEXT);
	await updateIndex(runtime, jobId, { status: "failed" });
	return true;
}

/** Drop one consumed run from the chat's durable index. */
export async function retireBackgroundRun(chatId: string, jobId: string): Promise<void> {
	const runtime = await openChatRuntime(chatId);
	await updateIndex(runtime, jobId, null);
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
		// A learner abort may have landed while the runtime was unavailable:
		// honor the durable intent before resolving the missing model or resuming.
		const job = (JOB_KINDS as readonly string[]).includes(descriptor.kind)
			? stores.jobStore.getJob(descriptor.jobId)
			: null;
		if (job !== null && job.status !== "running") {
			await conversation.abort(BACKGROUND_CONTEXT);
			await updateIndex(runtime, jobId, { status: "failed" });
			continue;
		}
		const engine = backgroundServices().resolveEngine?.(descriptor);
		if (!engine) {
			// FAIL CLOSED: `harness.resume()` below would execute the pending
			// generation without its model binding (or with a redirected
			// endpoint). Throw before scheduling; the committed input and run
			// stay intact and the next open retries.
			throw new Error(
				`the pending background run ${jobId} cannot be restored: its model ${modelKey(descriptor.model.provider, descriptor.model.modelId)} is unavailable`,
			);
		}
		bindRunEngine(descriptor.sessionId, engine, providerEventObserver(descriptor.chatId, `job:${descriptor.role}`));
		const extension = roleExtension(runtime, conversation, descriptor, roleHost(undefined));
		runtime.registry.install(extension);
		await conversation.configure(agentChange(descriptor, extension), BACKGROUND_CONTEXT);
	}
}
