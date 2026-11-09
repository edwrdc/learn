/**
 * Durable background roles (unit C, part 2): a process death during a demo,
 * PDF, visual or extraction run must leave everything a later process needs,
 * and the re-entry must finish the run WITHOUT re-submitting the input,
 * re-billing the completed work, or delivering an unverified artifact.
 *
 * The "process death" here is a real Harness close mid-model-call followed by
 * a fresh open (whose bootstrap reinstalls the role extension and engine
 * before `harness.resume()`). Faux models are the engines; the headless and
 * PDF work runs against fakes except the native pdf text tools (fixture).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type AssistantMessage,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-durable-roles-"));
process.env.LH_DATA_DIR = TMP;

const { chatStore } = await import("../src/session/store.ts");
const { closeChatRuntime, openChatRuntime } = await import("../src/session/durable.ts");
const {
	BackgroundRunDoc,
	BackgroundRunsDoc,
	configureBackgroundRuns,
} = await import("../src/jobs/runtime.ts");
type RunDescriptor = import("../src/jobs/durable-run.ts").RunDescriptor;
type BackgroundRunState = import("../src/jobs/durable-run.ts").RunState;
const { runDemoBuilder } = await import("../src/jobs/roles/demo.ts");
const { runVisualMaker } = await import("../src/jobs/roles/visual.ts");
const { runPdfReaderAgent } = await import("../src/jobs/roles/pdf.ts");
const { runSubmitAgent } = await import("../src/graph/extraction/submit-agent.ts");
const { subagentSummarizer } = await import("../src/session/compaction.ts");
const { headlessOverride } = await import("../src/jobs/headless.ts");
// The composition root wires the durable run/retire seams at module init.
await import("../src/session/turn.ts");
await import("./support-durable.ts");
type PiEngine = import("../src/platform/engines.ts").PiEngine;
type HeadlessApi = import("../src/jobs/headless.ts").HeadlessApi;
type DemoRunResult = import("../src/jobs/headless.ts").DemoRunResult;

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");
const CLEAN: DemoRunResult = { consoleErrors: [], pageErrors: [], failedRequests: [], ok: true };
const PNG_1PX = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);
const GOOD_HTML = '<!doctype html><html><body><canvas id="c"></canvas></body></html>';
const SVG_1 = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><line x1="10" y1="50" x2="290" y2="50"/></svg>';
const FINDINGS = { propositions: [{ id: "p1", name: "One", statement: "One true idea.", aliases: [] }], chains: [] };

after(() => {
	headlessOverride.current = undefined;
	fs.rmSync(TMP, { recursive: true, force: true });
});

interface CountedEngine extends PiEngine {
	calls: number;
}
function fauxEngine(steps: FauxResponseStep[]): CountedEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	const engine: CountedEngine = {
		calls: 0,
		model: faux.getModel(),
		streamFn: (model, context, options) => {
			engine.calls++;
			return faux.streamSimple(model, context, options);
		},
	};
	return engine;
}

/** A model call that never resolves until its abort signal fires (the close
 *  aborts the harness's task). */
function hangUntilAborted(): FauxResponseStep {
	return ((_context: unknown, options: { signal?: AbortSignal } | undefined) =>
		new Promise<AssistantMessage>((resolve) => {
			const signal = options?.signal;
			const finish = () => resolve(fauxAssistantMessage("interrupted"));
			if (signal?.aborted) finish();
			else signal?.addEventListener("abort", finish, { once: true });
		})) as unknown as FauxResponseStep;
}

function fakeHeadless(): HeadlessApi & { demoRuns: string[]; svgRenders: string[] } {
	const api = {
		demoRuns: [] as string[],
		svgRenders: [] as string[],
		available: () => true,
		unavailableReason: () => null,
		async runDemo(): Promise<DemoRunResult> {
			api.demoRuns.push("run");
			return CLEAN;
		},
		async renderSvg(): Promise<Buffer> {
			api.svgRenders.push("render");
			return PNG_1PX;
		},
		async renderPdfPages(_file: string, pages: number[]) {
			return pages.map((page) => ({ page, png: PNG_1PX }));
		},
	};
	return api;
}

/** Reopen with the resumed engine resolvable from the persisted descriptor —
 *  the bootstrap's job before `harness.resume()`. */
async function reopen(chatId: string, engine: CountedEngine, headless: HeadlessApi): Promise<void> {
	configureBackgroundRuns({
		resolveEngine: (descriptor: RunDescriptor) =>
			descriptor.model.provider === engine.model.provider && descriptor.model.modelId === engine.model.id
				? engine
				: undefined,
		searchProvider: () => null,
		headless: () => headless,
	});
	await openChatRuntime(chatId);
}

async function waitFor(cond: () => boolean, timeoutMs = 10000, what = "condition"): Promise<void> {
	const started = Date.now();
	for (;;) {
		if (cond()) return;
		if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function runConversationId(chatId: string, jobId: string): Promise<number | undefined> {
	const runtime = await openChatRuntime(chatId);
	const index = (await runtime.harness.snapshot(BackgroundRunsDoc, BACKGROUND_CONTEXT)) as unknown as {
		runs: Record<string, { conversationId: number }>;
	};
	return index.runs[jobId]?.conversationId;
}

/** The run's placed string inputs (image-in-the-loop messages are arrays and
 *  are not inputs). */
async function childInputs(chatId: string, jobId: string): Promise<number> {
	const id = await runConversationId(chatId, jobId);
	if (id === undefined) return 0;
	return userInputs(chatId, id);
}

async function userInputs(chatId: string, conversationId: number): Promise<number> {
	const runtime = await openChatRuntime(chatId);
	const conversation = await runtime.harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
	if (!conversation) return 0;
	let users = 0;
	let cursor: Record<string, unknown> | undefined;
	for (;;) {
		const page = await conversation.entries({ order: "ascending" }, 256, cursor as never, BACKGROUND_CONTEXT);
		for (const entry of page.items) {
			const message = entry.model?.[0] as { role?: string; content?: unknown } | undefined;
			if (message?.role === "user" && typeof message.content === "string") users++;
		}
		if (!page.next) return users;
		cursor = page.next as Record<string, unknown>;
	}
}

async function descriptorOf(chatId: string, jobId: string): Promise<RunDescriptor | undefined> {
	const runtime = await openChatRuntime(chatId);
	const index = (await runtime.harness.snapshot(BackgroundRunsDoc, BACKGROUND_CONTEXT)) as unknown as {
		runs: Record<string, { conversationId: number }>;
	};
	const id = index.runs[jobId]?.conversationId;
	if (id === undefined) return undefined;
	return (await runtime.harness.snapshot(BackgroundRunDoc, id as never, BACKGROUND_CONTEXT)) as
		| RunDescriptor
		| undefined;
}

describe("durable role restart (real close, fresh open)", () => {
	it("demo: resumes from the persisted html and finishes with one verification", async () => {
		const chat = await chatStore.createChat("Durable: demo restart");
		const headless = fakeHeadless();
		headlessOverride.current = headless;
		const run = { chatId: chat.id, jobId: "demo-restart" };
		const first = fauxEngine([
			fauxAssistantMessage([fauxToolCall("write_demo", { html: GOOD_HTML }, { id: "w1" })], { stopReason: "toolUse" }),
			hangUntilAborted(),
		]);
		const firstRun = runDemoBuilder({ title: "T", brief: "b" }, { engine: first, headless, run });
		await waitFor(() => first.calls >= 2, 10000, "the demo model call mid-flight");
		await closeChatRuntime(chat.id);
		await assert.rejects(firstRun, (err: unknown) => err instanceof Error && err.name === "AbortError");

		const resumed = fauxEngine([
			fauxAssistantMessage([fauxToolCall("run_demo", {}, { id: "r1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Sweep the slider.")]),
		]);
		await reopen(chat.id, resumed, headless);
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { engine: resumed, headless, run });

		assert.equal(result.html, GOOD_HTML, "the pre-close html is the deliverable");
		assert.equal(result.notes, "Sweep the slider.");
		assert.equal(headless.demoRuns.length, 1, "the resumed run_demo verified it — no extra final verification");
		assert.equal(resumed.calls, 2, "the resumed generation made the remaining calls only");
		assert.equal(await childInputs(chat.id, run.jobId), 1, "one placed input across the restart");
	});

	it("pdf: page state survives and the brief finishes from the reattached conversation", async () => {
		const chat = await chatStore.createChat("Durable: pdf restart");
		const headless = fakeHeadless();
		headlessOverride.current = headless;
		const run = { chatId: chat.id, jobId: "pdf-restart" };
		const first = fauxEngine([
			fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "1-2" }, { id: "e1" })], { stopReason: "toolUse" }),
			hangUntilAborted(),
		]);
		const firstRun = runPdfReaderAgent({ path: FIXTURE, question: "what is on page one?" }, { engine: first, headless, run });
		await waitFor(() => first.calls >= 2, 10000, "the pdf model call mid-flight");
		await closeChatRuntime(chat.id);
		await assert.rejects(firstRun, (err: unknown) => err instanceof Error && err.name === "AbortError");

		const resumed = fauxEngine([fauxAssistantMessage([fauxText("The rule is on page 1 (p. 1). Pages consulted: 1, 2")])]);
		await reopen(chat.id, resumed, headless);
		const result = await runPdfReaderAgent({ path: FIXTURE, question: "what is on page one?" }, { engine: resumed, headless, run });

		assert.match(result.brief, /page 1/);
		assert.deepEqual(result.pagesRead, [1, 2], "extracted pages were persisted before the close");
		assert.deepEqual(result.pagesConsulted, [1, 2]);
		assert.equal(resumed.calls, 1, "the resumed run answered directly");
		assert.equal(await childInputs(chat.id, run.jobId), 1);
	});

	it("visual: the resumed run renders, looks and delivers the verified SVG", async () => {
		const chat = await chatStore.createChat("Durable: visual restart");
		const headless = fakeHeadless();
		headlessOverride.current = headless;
		const run = { chatId: chat.id, jobId: "visual-restart" };
		const first = fauxEngine([
			fauxAssistantMessage([fauxToolCall("write_svg", { svg: SVG_1 }, { id: "w1" })], { stopReason: "toolUse" }),
			hangUntilAborted(),
		]);
		const firstRun = runVisualMaker({ brief: "a line" }, { engine: first, headless, run });
		await waitFor(() => first.calls >= 2, 10000, "the visual model call mid-flight");
		await closeChatRuntime(chat.id);
		await assert.rejects(firstRun, (err: unknown) => err instanceof Error && err.name === "AbortError");

		const resumed = fauxEngine([
			fauxAssistantMessage([fauxToolCall("render_svg", {}, { id: "r1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("A horizontal line.")]),
		]);
		await reopen(chat.id, resumed, headless);
		const result = await runVisualMaker({ brief: "a line" }, { engine: resumed, headless, run });

		assert.equal(result.svg, SVG_1, "the persisted SVG is delivered");
		assert.equal(result.notes, "A horizontal line.");
		assert.equal(headless.svgRenders.length, 1, "one render of the final SVG (the look gate)");
		assert.equal(await childInputs(chat.id, run.jobId), 1);
	});

	it("extractor: reattaches without a duplicate input; a consumed run is not replayed", async () => {
		const chat = await chatStore.createChat("Durable: extraction restart");
		const run = { chatId: chat.id, jobId: "extract-restart" };
		const common = {
			role: "extractor" as const,
			variant: "notes-findings" as const,
			systemPrompt: "s",
			prompt: "p",
			existingIds: [] as string[],
			onStep: () => undefined,
			neverSubmitted: "the extractor never submitted findings",
			signal: undefined,
			run,
		};
		const first = fauxEngine([hangUntilAborted()]);
		const firstRun = runSubmitAgent({ ...common, engine: first });
		await waitFor(() => first.calls >= 1, 10000, "the extractor model call mid-flight");
		await closeChatRuntime(chat.id);
		await assert.rejects(firstRun, (err: unknown) => err instanceof Error && err.name === "AbortError");

		const resumed = fauxEngine([
			fauxAssistantMessage([fauxToolCall("submit_findings", FINDINGS, { id: "s1" })], { stopReason: "toolUse" }),
		]);
		const headless = fakeHeadless();
		await reopen(chat.id, resumed, headless);
		const conversationId = await runConversationId(chat.id, run.jobId);
		assert.ok(conversationId !== undefined, "the interrupted run is indexed for reattach");
		const value = await runSubmitAgent<{ propositions: unknown[] }>({ ...common, engine: resumed });
		assert.deepEqual(value, FINDINGS);
		assert.equal(await userInputs(chat.id, conversationId!), 1, "the resumed generation reused its committed input");

		// Consumed (retired): the same identity with a new engine is a fresh
		// run — a settled submit is never replayed as a second extraction.
		const second = fauxEngine([
			fauxAssistantMessage([fauxToolCall("submit_findings", { propositions: [], chains: [] }, { id: "s2" })], { stopReason: "toolUse" }),
		]);
		configureBackgroundRuns({ resolveEngine: () => second, searchProvider: () => null, headless: () => headless });
		const again = await runSubmitAgent<{ propositions: unknown[] }>({ ...common, engine: second });
		assert.deepEqual(again, { propositions: [], chains: [] });
		assert.equal(second.calls, 1, "the retired run did not replay the first submit");
	});

	it("extractor: the validated submit is committed into the run state before the result", async () => {
		const chat = await chatStore.createChat("Durable: submit capture");
		const headless = fakeHeadless();
		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("submit_findings", FINDINGS, { id: "s1" })], { stopReason: "toolUse" }),
		]);
		configureBackgroundRuns({ resolveEngine: () => engine, searchProvider: () => null, headless: () => headless });
		const { runBackgroundConversation } = await import("../src/jobs/runtime.ts");
		const outcome = await runBackgroundConversation({
			jobId: "extract-capture",
			chatId: chat.id,
			kind: "extract",
			role: "extractor",
			engine,
			maxTurns: 4,
			systemPrompt: "s",
			prompt: "p",
			input: { submit: "notes-findings", existingIds: [] },
		});
		assert.deepEqual((outcome.state as { submitted: unknown }).submitted, FINDINGS);
		const descriptor = await descriptorOf(chat.id, "extract-capture");
		assert.deepEqual((descriptor!.state as { submitted: unknown }).submitted, FINDINGS);
	});
});

describe("durable role caps and concurrency", () => {
	it("pdf: the cap ends the run with the iteration-limit failure, never an invented brief", async () => {
		const chat = await chatStore.createChat("Durable: pdf cap");
		const headless = fakeHeadless();
		headlessOverride.current = headless;
		const engine = fauxEngine(
			[1, 2, 3].map((n) =>
				fauxAssistantMessage([fauxToolCall("pdf_info", {}, { id: `i${n}` })], { stopReason: "toolUse" }),
			),
		);
		configureBackgroundRuns({ resolveEngine: () => engine, searchProvider: () => null, headless: () => headless });
		const result = await runPdfReaderAgent(
			{ path: FIXTURE, question: "q" },
			{ engine, headless, run: { chatId: chat.id, jobId: "pdf-cap" }, maxIterations: 3 },
		);
		assert.match(result.brief, /^PDF failed: iteration limit \(3\) reached without a brief\.$/);
		assert.deepEqual(result.pagesRead, []);
		assert.equal(engine.calls, 3);
	});

	it("visual: the cap never delivers an unlooked SVG", async () => {
		const chat = await chatStore.createChat("Durable: visual cap");
		const headless = fakeHeadless();
		headlessOverride.current = headless;
		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("write_svg", { svg: SVG_1 }, { id: "w1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Done, trust me.")]),
		]);
		configureBackgroundRuns({ resolveEngine: () => engine, searchProvider: () => null, headless: () => headless });
		const result = await runVisualMaker(
			{ brief: "a line" },
			{ engine, headless, run: { chatId: chat.id, jobId: "visual-cap" }, maxIterations: 2 },
		);
		assert.equal(result.svg, "");
		assert.match(result.notes ?? "", /^FAILED: iteration limit \(2\) reached without a verified SVG\.$/);
		assert.equal(headless.svgRenders.length, 0, "the cap stopped the forced look");
	});

	it("research and visual run concurrently on one Harness, each on its own engine", async () => {
		const chat = await chatStore.createChat("Durable: concurrent roles");
		const headless = fakeHeadless();
		headlessOverride.current = headless;
		const { runBackgroundConversation } = await import("../src/jobs/runtime.ts");
		const research = fauxEngine([
			fauxAssistantMessage([fauxToolCall("web_search", { query: "router isolation" }, { id: "ws1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Research brief")]),
		]);
		const visual = fauxEngine([
			fauxAssistantMessage([fauxToolCall("write_svg", { svg: SVG_1 }, { id: "w1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("render_svg", {}, { id: "r1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Visual notes")]),
		]);
		const searched: string[] = [];
		configureBackgroundRuns({ resolveEngine: () => undefined, searchProvider: () => null, headless: () => headless });
		const [researchOutcome, visualOutcome] = await Promise.all([
			runBackgroundConversation({
				jobId: "concurrent-research",
				chatId: chat.id,
				kind: "research",
				role: "researcher",
				engine: research,
				maxTurns: 12,
				systemPrompt: "r",
				prompt: "p",
				search: () => ({ id: "tavily", search: async (q: string) => {
					searched.push(q);
					return [{ title: "t", url: "https://example.com/t", snippet: "s" }];
				} }),
			}),
			runBackgroundConversation({
				jobId: "concurrent-visual",
				chatId: chat.id,
				kind: "visual",
				role: "visualMaker",
				engine: visual,
				maxTurns: 8,
				systemPrompt: "v",
				prompt: "a line",
				input: { brief: "a line" },
			}),
		]);
		assert.equal(researchOutcome.text, "Research brief");
		assert.equal((researchOutcome.state as { kind: string }).kind, "research");
		assert.equal(visualOutcome.text, "Visual notes");
		assert.equal((visualOutcome.state as { renderedSvg: string }).renderedSvg, SVG_1, "the visual run's state is its own");
		assert.deepEqual(searched, ["router isolation"], "each engine ran only its own conversation's calls");
		assert.equal(research.calls, 2);
		assert.equal(visual.calls, 3);
	});

	it("compaction uses the durable runner: identical spans reuse one conversation", async () => {
		const chat = await chatStore.createChat("Durable: compaction");
		const engine = fauxEngine([fauxAssistantMessage([fauxText("A compacted summary.")])]);
		const headless = fakeHeadless();
		configureBackgroundRuns({ resolveEngine: () => engine, searchProvider: () => null, headless: () => headless });
		const first = await subagentSummarizer("span text", engine, chat.id);
		const second = await subagentSummarizer("span text", engine, chat.id);
		assert.equal(first.summary, "A compacted summary.");
		assert.equal(second.summary, first.summary);
		assert.equal(engine.calls, 1, "the same span reattached its conversation — no second model call");
		const runtime = await openChatRuntime(chat.id);
		const index = (await runtime.harness.snapshot(BackgroundRunsDoc, BACKGROUND_CONTEXT)) as unknown as {
			runs: Record<string, { kind: string }>;
		};
		assert.ok(
			Object.entries(index.runs).some(([key, ref]) => key.startsWith(`compact:${chat.id}:`) && ref.kind === "compact"),
			"the summary ran as a durable compact run",
		);
	});
});

describe("durable role state shape", () => {
	it("every kind seeds the discriminated state union", async () => {
		const { initialState } = await import("../src/jobs/durable-run.ts");
		const kinds: BackgroundRunState["kind"][] = ["research", "demo", "visual", "pdf", "extract", "audit", "compact"];
		for (const kind of kinds) assert.equal(initialState(kind).kind, kind);
	});
});
