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
import type { ModelRole } from "../settings/model/index.ts";
import { accumulateJobUsage, type JobUsage } from "./model/types.ts";
import { usageFromPi } from "../session/model/index.ts";
import { createWebTools } from "../tools/index.ts";
import { createPdfReadTools } from "../tools/index.ts";
import { auditorGraphTools, type GraphToolContext } from "../graph/index.ts";
import { toRegistrations, type AppTool, type AppToolResult } from "../tools/index.ts";
import { bindRunEngine, unbindRunEngine, type PiEngine } from "../platform/index.ts";
import { providerEventObserver } from "../platform/index.ts";
import type { SearchProvider } from "../tools/model/index.ts";
import { openChatRuntime, type ChatRuntime } from "../session/index.ts";
import { registerJobAbort } from "./aborts.ts";
import {
	initialState,
	type BackgroundKind,
	type BackgroundRunRequest,
	type BackgroundRunResult,
	type DemoRunState,
	type PdfRunState,
	type RoleStateIo,
	type RunDescriptor,
	type RunState,
	type RunStep,
	type SubmitRunState,
	type VisualRunState,
} from "./durable-run.ts";

export type {
	BackgroundRunRequest,
	BackgroundRunResult,
	RunDescriptor,
	RunRole,
	RunState,
} from "./durable-run.ts";
import { demoRoleTools } from "./roles/demo.ts";
import {
	pdfImageContent,
	pdfRoleTools,
	PDF_UNREAD_MESSAGE,
} from "./roles/pdf.ts";
import {
	visualImageContent,
	visualRoleTools,
	VISUAL_UNLOOKED_MESSAGE,
} from "./roles/visual.ts";
import {
	AUDIT_TOOL,
	FINDINGS_TOOL,
	submitRoleTool,
	type SubmitRunInput,
} from "../graph/index.ts";
import { getHeadless, type HeadlessApi } from "./headless.ts";
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
	/** Verification engines (tests inject; production resolves the app's
	 *  own browser/native rasterizers at call time). */
	headless?(): HeadlessApi;
	/** The live graph the auditor explores (production: the real stores;
	 *  tests inject their ledgers). */
	graphContext?(): GraphToolContext;
}

function backgroundHost(): { services?: BackgroundServices } {
	return processState("backgroundServices", () => ({}));
}

export function configureBackgroundRuns(next: BackgroundServices): void {
	backgroundHost().services = next;
}

/** What one role's tools and hooks need at build time. */
interface RoleDeps {
	search: () => SearchProvider | null;
	headless: () => HeadlessApi;
	graph: () => GraphToolContext;
	/** The run descriptor of one conversation (a committed read). */
	readRun: (conversationId: ConversationId) => Promise<RunDescriptor | undefined>;
	onActivity?: (line: string) => void;
}

function productionGraph(): GraphToolContext {
	return { chatStore: stores.chatStore, graphStore: stores.graphStore };
}

function roleDeps(
	runtime: ChatRuntime,
	request: BackgroundRunRequest | undefined,
	host: BackgroundServices | undefined,
): RoleDeps {
	return {
		search: request?.search ?? (() => host?.searchProvider() ?? null),
		headless: () => request?.headless ?? host?.headless?.() ?? getHeadless(),
		graph: () => request?.graph ?? host?.graphContext?.() ?? productionGraph(),
		readRun: async (conversationId) =>
			(await runtime.harness.snapshot(BackgroundRunDoc, conversationId, BACKGROUND_CONTEXT)) as
				| RunDescriptor
				| undefined,
		onActivity: request?.onActivity,
	};
}

/** The persisted role state as a read/modify handle for the role's tools. */
function roleState<T extends RunState>(conversation: Conversation, deps: RoleDeps): RoleStateIo<T> {
	return {
		read: async () => {
			const run = await deps.readRun(conversation.id);
			if (!run) throw new Error(`background run: descriptor missing on conversation ${conversation.id}`);
			return run.state as T;
		},
		update: async (mutate) => {
			await conversation.commit(async (tx) => {
				const run = (await tx.doc(BackgroundRunDoc, conversation.id)) as unknown as RunDescriptor;
				mutate(run.state as T);
			}, BACKGROUND_CONTEXT);
		},
	};
}

/** Persist role state BEFORE the tool result becomes visible: the wrapper
 *  returns the tool's result only after the state commit landed, so a crash
 *  cannot leave a committed deliverable missing its recovery state. */
function withRunState(
	registration: ToolRegistration,
	kind: BackgroundKind,
	onActivity: ((line: string) => void) | undefined,
): ToolRegistration {
	return {
		...registration,
		execute: async (args, api, context) => {
			const result = await registration.execute(args as never, api, context);
			let activity = "";
			await api.commit(async (tx) => {
				const run = (await tx.doc(BackgroundRunDoc, api.conversationId)) as unknown as RunDescriptor;
				recordToolState(kind, run, registration.name, args, result);
				activity = run.activity;
			}, context);
			if (activity) onActivity?.(activity);
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
	const state = run.state as { kind: "research"; fetchedUrls: string[] };
	const url = (args as { url?: unknown } | undefined)?.url;
	if (
		typeof url === "string" &&
		(toolName === "web_fetch" || toolName === "web_fetch_pdf") &&
		!result.isError &&
		!state.fetchedUrls.includes(url)
	) {
		state.fetchedUrls.push(url);
	}
	run.activity = activityLine(toolName, args);
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

/** The role's tool registrations, rebuilt from the persisted descriptor. */
function roleTools(
	conversation: Conversation,
	descriptor: RunDescriptor,
	deps: RoleDeps,
): ToolRegistration[] {
	switch (descriptor.kind) {
		case "research": {
			const tools: Record<string, AppTool<any>> = { ...createWebTools(deps.search) };
			const pdfDir = (descriptor.input as { pdfDir?: string }).pdfDir;
			if (typeof pdfDir === "string" && pdfDir.length > 0) {
				Object.assign(tools, createPdfReadTools(pdfDir));
			}
			return toRegistrations(tools).map((registration) =>
				withRunState(registration, descriptor.kind, deps.onActivity),
			);
		}
		case "demo":
			return toRegistrations(
				demoRoleTools(roleState<DemoRunState>(conversation, deps), deps.headless(), deps.onActivity),
			);
		case "visual":
			return toRegistrations(
				visualRoleTools(roleState<VisualRunState>(conversation, deps), deps.headless(), deps.onActivity),
			);
		case "pdf": {
			const path = String((descriptor.input as { path?: unknown }).path ?? "");
			return toRegistrations(
				pdfRoleTools(roleState<PdfRunState>(conversation, deps), path, deps.headless(), deps.onActivity),
			);
		}
		case "extract":
		case "audit": {
			const input = descriptor.input as unknown as SubmitRunInput;
			const submit = submitRoleTool(input, roleState<SubmitRunState>(conversation, deps));
			if (descriptor.kind === "extract") return toRegistrations({ [submit.name]: submit });
			return toRegistrations({ ...auditorGraphTools(deps.graph()), [submit.name]: submit });
		}
		case "compact":
			return [];
	}
}

/** The role extension: the tools plus the durable turn cap and the role's
 *  hook behavior (image-in-the-loop messages, the PDF doctrine nudge, the
 *  clean-submit stop). The cap counts committed assistant entries, so it
 *  survives a restart without a closure counter. */
function roleExtension(
	conversation: Conversation,
	descriptor: RunDescriptor,
	deps: RoleDeps,
): Extension {
	return defineExtension({
		name: `lh-bg-${descriptor.runId}`,
		tools: roleTools(conversation, descriptor, deps),
		hooks: [
			hook(GenerationTask, {
				afterTools: async (_assistant, results, api, context) => {
					// Flush the round's render first, or a last-iteration image
					// goes unseen.
					await flushPendingRender(conversation, descriptor, deps);
					if (await cleanSubmitInRound(descriptor, results, api, context)) return { terminate: true };
					const assistant = await countAssistantEntries(conversation);
					if (assistant >= descriptor.maxTurns) {
						await markCapped(conversation);
						return { terminate: true };
					}
					return undefined;
				},
				onYield: async () => roleYield(conversation, descriptor, deps),
			}),
		],
	});
}

function submitToolName(kind: BackgroundKind): string | null {
	if (kind === "audit") return AUDIT_TOOL;
	if (kind === "extract") return FINDINGS_TOOL;
	return null;
}

/** A round that carries a schema-valid, accepted submit ends the run even
 *  when the model batched other calls beside it. */
async function cleanSubmitInRound(
	descriptor: RunDescriptor,
	results: readonly EntryId[],
	api: HookApi,
	context: Context,
): Promise<boolean> {
	const toolName = submitToolName(descriptor.kind);
	if (!toolName) return false;
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

/** The image-in-the-loop flush: the render tool committed a pending render;
 *  render it, then commit the pages/SVG as seen and append the user message
 *  AFTER the round's tool results, in one transaction. */
async function flushPendingRender(
	conversation: Conversation,
	descriptor: RunDescriptor,
	deps: RoleDeps,
): Promise<void> {
	if (descriptor.kind !== "visual" && descriptor.kind !== "pdf") return;
	const state = (await roleState<VisualRunState | PdfRunState>(conversation, deps).read());
	if (descriptor.kind === "visual") {
		const visual = state as VisualRunState;
		if (!visual.pendingRender || !visual.currentSvg) return;
		const svg = visual.currentSvg;
		let png: Buffer;
		try {
			png = await deps.headless().renderSvg(svg);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await conversation.commit(async (tx) => {
				const run = (await tx.doc(BackgroundRunDoc, conversation.id)) as unknown as RunDescriptor;
				(run.state as VisualRunState).pendingRender = false;
				await tx.appendEntry(conversation.id, {
					kind: "lh.bg-image",
					model: [
						{
							role: "user",
							content: `RENDER ERROR (the SVG may be malformed): ${msg}. Fix it with write_svg and render again.`,
							timestamp: Date.now(),
						},
					],
				});
			}, BACKGROUND_CONTEXT);
			return;
		}
		await conversation.commit(async (tx) => {
			const run = (await tx.doc(BackgroundRunDoc, conversation.id)) as unknown as RunDescriptor;
			const next = run.state as VisualRunState;
			next.pendingRender = false;
			next.renderedSvg = svg;
			await tx.appendEntry(conversation.id, {
				kind: "lh.bg-image",
				model: [{ role: "user", content: visualImageContent(png), timestamp: Date.now() } as never],
			});
		}, BACKGROUND_CONTEXT);
		return;
	}
	if (descriptor.kind === "pdf") {
		const pdf = state as PdfRunState;
		if (!pdf.pendingRender) return;
		const { pages, dpi } = pdf.pendingRender;
		const path = String((descriptor.input as { path?: unknown }).path ?? "");
		let rendered: Awaited<ReturnType<HeadlessApi["renderPdfPages"]>> | undefined;
		try {
			rendered = await deps.headless().renderPdfPages(path, pages, { dpi });
			if (rendered.length === 0) throw new Error("no pages rendered (spec matched nothing?)");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await conversation.commit(async (tx) => {
				const run = (await tx.doc(BackgroundRunDoc, conversation.id)) as unknown as RunDescriptor;
				(run.state as PdfRunState).pendingRender = null;
				await tx.appendEntry(conversation.id, {
					kind: "lh.bg-image",
					model: [
						{
							role: "user",
							content: `RENDER ERROR (the page spec may be wrong): ${msg}. Narrow the spec and render again.`,
							timestamp: Date.now(),
						},
					],
				});
			}, BACKGROUND_CONTEXT);
			return;
		}
		await conversation.commit(async (tx) => {
			const run = (await tx.doc(BackgroundRunDoc, conversation.id)) as unknown as RunDescriptor;
			const next = run.state as PdfRunState;
			next.pendingRender = null;
			for (const page of rendered) {
				if (!next.consulted.includes(page.page)) next.consulted.push(page.page);
				if (!next.read.includes(page.page)) next.read.push(page.page);
			}
			await tx.appendEntry(conversation.id, {
				kind: "lh.bg-image",
				model: [{ role: "user", content: pdfImageContent(rendered), timestamp: Date.now() } as never],
			});
		}, BACKGROUND_CONTEXT);
	}
}

/** The role's answer boundary: the PDF doctrine's single nudge and the
 *  visual-maker's verify-by-looking gate. */
async function roleYield(
	conversation: Conversation,
	descriptor: RunDescriptor,
	deps: RoleDeps,
): Promise<
	| {
			continue: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	  }
	| undefined
> {
	if (descriptor.kind !== "visual" && descriptor.kind !== "pdf") return undefined;
	const state = await roleState<VisualRunState | PdfRunState>(conversation, deps).read();
	if (descriptor.kind === "pdf") {
		const pdf = state as PdfRunState;
		if (pdf.consulted.length > 0) return undefined;
		if (await nudgeAlreadySent(conversation)) return undefined;
		if ((await countAssistantEntries(conversation)) + 1 >= descriptor.maxTurns) {
			await markCapped(conversation);
			await conversation.commit(async (tx) => {
				const run = (await tx.doc(BackgroundRunDoc, conversation.id)) as unknown as RunDescriptor;
				(run.state as PdfRunState).blockedAtCap = true;
			}, BACKGROUND_CONTEXT);
			return undefined;
		}
		return { continue: PDF_UNREAD_MESSAGE };
	}
	if (descriptor.kind === "visual") {
		const visual = state as VisualRunState;
		if (!visual.currentSvg || visual.renderedSvg === visual.currentSvg) return undefined;
		if ((await countAssistantEntries(conversation)) + 1 >= descriptor.maxTurns) {
			await markCapped(conversation);
			return undefined;
		}
		const svg = visual.currentSvg;
		let png: Buffer;
		try {
			png = await deps.headless().renderSvg(svg);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await conversation.commit(async (tx) => {
				const run = (await tx.doc(BackgroundRunDoc, conversation.id)) as unknown as RunDescriptor;
				(run.state as VisualRunState).renderError = msg;
			}, BACKGROUND_CONTEXT);
			return undefined;
		}
		await conversation.commit(async (tx) => {
			const run = (await tx.doc(BackgroundRunDoc, conversation.id)) as unknown as RunDescriptor;
			(run.state as VisualRunState).renderedSvg = svg;
		}, BACKGROUND_CONTEXT);
		return {
			continue: [
				{ type: "text", text: VISUAL_UNLOOKED_MESSAGE },
				{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
			],
		};
	}
	return undefined;
}

async function nudgeAlreadySent(conversation: Conversation): Promise<boolean> {
	for (const entry of await readRunEntries(conversation)) {
		const message = entry.model?.[0] as { role?: string; content?: unknown } | undefined;
		if (message?.role === "user" && message.content === PDF_UNREAD_MESSAGE) return true;
	}
	return false;
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
function abortedSettlement(signals: readonly (AbortSignal | undefined)[]): Promise<{
	status: "unanswered";
	reason: "aborted";
}> {
	return new Promise((resolve) => {
		const done = () => resolve({ status: "unanswered", reason: "aborted" });
		for (const signal of signals) {
			if (!signal) continue;
			if (signal.aborted) {
				done();
				return;
			}
			signal.addEventListener("abort", done, { once: true });
		}
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
			model: `${message.provider}:${message.model}`,
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
		input: {
			...(request.input ?? {}),
			...(pdfDir ? { pdfDir } : {}),
		} as JsonObject,
		state: initialState(request.kind),
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
	const host = backgroundHost().services;
	const requestedModel = request.engine.model;
	const sameEndpoint =
		!descriptor.model.baseUrl || requestedModel.baseUrl === descriptor.model.baseUrl;
	const engine =
		requestedModel.provider === descriptor.model.provider &&
		requestedModel.id === descriptor.model.modelId &&
		sameEndpoint
			? request.engine
			: host?.resolveEngine(descriptor);
	if (!engine) throw new Error(`no model available for background run ${descriptor.runId}`);
	bindRunEngine(descriptor.sessionId, engine, providerEventObserver(descriptor.chatId, `job:${descriptor.role}`));
	const deps = roleDeps(runtime, request, host);
	const extension = roleExtension(conversation, descriptor, deps);
	runtime.registry.install(extension);
	const abort = request.abort ?? new AbortController();
	const abortConversation = () => {
		void conversation.abort(BACKGROUND_CONTEXT).catch(() => undefined);
	};
	abort.signal.addEventListener("abort", abortConversation, { once: true });
	if (request.signal) {
		if (request.signal.aborted) abortConversation();
		else request.signal.addEventListener("abort", abortConversation, { once: true });
	}
	if (request.abort) {
		registerJobAbort(request.jobId, abort, () => {
			void conversation.abort(BACKGROUND_CONTEXT).catch((error) => {
				console.error(`[job ${request.jobId}] durable abort failed:`, error);
			});
		});
	}
	let usageWatch: Awaited<ReturnType<ChatRuntime["harness"]["watchDoc"]>> | undefined;
	try {
		await conversation.configure(agentChange(descriptor, extension), BACKGROUND_CONTEXT);
		const model = `${engine.model.provider}:${engine.model.id}`;
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
			abortedSettlement([abort.signal, request.signal]),
		]);
		await reportProgress();
		if (settled.status !== "done") {
			if (abort.signal.aborted || request.signal?.aborted) {
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
		if ((abort.signal.aborted || request.signal?.aborted) && !(error instanceof Error && error.name === "AbortError")) {
			const stopped = new Error(error instanceof Error ? error.message : String(error));
			stopped.name = "AbortError";
			throw stopped;
		}
		if (error instanceof Error) {
			// The caller's failure shape may quote what the run had honestly
			// reached (the PDF brief's page sets).
			const stored = (await runtime.harness
				.snapshot(BackgroundRunDoc, conversation.id, BACKGROUND_CONTEXT)
				.catch(() => undefined)) as RunDescriptor | undefined;
			if (stored) (error as Error & { runState?: RunState }).runState = stored.state;
		}
		throw error;
	} finally {
		await usageWatch?.stop().catch(() => undefined);
		abort.signal.removeEventListener("abort", abortConversation);
		request.signal?.removeEventListener("abort", abortConversation);
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
		const engine = backgroundHost().services?.resolveEngine(descriptor);
		if (!engine) {
			// FAIL CLOSED: `harness.resume()` below would execute the pending
			// generation without its model binding (or with a redirected
			// endpoint). Throw before scheduling; the committed input and run
			// stay intact and the next open retries.
			throw new Error(
				`the pending background run ${jobId} cannot be restored: its model ${descriptor.model.provider}:${descriptor.model.modelId} is unavailable`,
			);
		}
		bindRunEngine(descriptor.sessionId, engine, providerEventObserver(descriptor.chatId, `job:${descriptor.role}`));
		const extension = roleExtension(conversation, descriptor, roleDeps(runtime, undefined, backgroundHost().services));
		runtime.registry.install(extension);
		await conversation.configure(agentChange(descriptor, extension), BACKGROUND_CONTEXT);
	}
}
