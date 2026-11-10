import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { CompactionDeps } from "../src/session/compaction.ts";
import type { LhMessage } from "../src/session/model/transcript.ts";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-compaction-dismissal-"));
process.env.LH_DATA_DIR = data;
process.env.OPENROUTER_API_KEY = "test-key-presence-gate";
const { PATHS } = await import("../src/platform/config.ts");
assert.equal(PATHS.data, data);
const { chatStore } = await import("../src/session/store.ts");
const { closeChatRuntime } = await import("../src/session/durable.ts");
const { ensureCompacted, kickCompaction, awaitCompaction } = await import("../src/session/compaction.ts");
const { danglingQuestionOf, newUserMessage } = await import("../src/session/model/transcript.ts");
const { activeCompactionOf, keptIndexFor } = await import("../src/session/model/compaction.ts");
const { POST: dismissPOST } = await import("../src/routes/api/chats/[id]/dismiss/+server.ts");
const { handleChatInput } = await import("../src/session/turn.ts");
await import("./support-durable.ts");
const { services } = await import("../src/boot.ts");
const { runningTurn } = await import("../src/session/turn-runs.ts");
const { isTurnRunning } = await import("../src/session/turn-liveness.ts");
const { configureBackgroundRuns } = await import("../src/jobs/durable-run.ts");
const { writeSettings } = await import("../src/settings/store.ts");
const { bareQuestionTools } = await import("./support-tools.ts");
const { stores } = await import("../src/stores.ts");
writeSettings({ version: 1, compaction: { thresholdTokens: 40_000 }, graph: { enabled: false } });
const chats: string[] = [];
after(async () => {
	for (const id of chats) await closeChatRuntime(id);
	fs.rmSync(data, { recursive: true, force: true });
});

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const question = { question: "Q?", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A", explanation: "A fits.", type: "check", nodeId: "test-node" };
const dismissal = { kind: "quiz" as const, questionText: "Q?", answers: [], dontKnow: true, dismissed: true, answeredAt: "2026-01-01T00:00:00.000Z" };
const answer = { ...dismissal, dismissed: false, dontKnow: false, answers: [{ index: 1, label: "A", value: "A" }], correct: true, thinking: "A fits." };

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function seed(parallel = false) {
	const chat = chatStore.createChat("compaction dismissal");
	chats.push(chat.id);
	await chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	const ids = parallel ? ["q", "q2"] : ["q"];
	const pose: LhMessage = {
		id: "pose", role: "assistant", content: ids.map((id) => ({ type: "toolCall", id, name: "quiz", arguments: question })),
		api: "openai-completions", provider: "openrouter", model: "test", usage, stopReason: "toolUse", timestamp: 1,
	};
	const results: LhMessage[] = ids.map((id) => ({
		id: "placeholder-" + id, role: "toolResult", toolCallId: id, toolName: "quiz",
		content: [{ type: "text", text: "Question posed" }], details: null, isError: false, timestamp: 2,
	}));
	await chatStore.saveMessages(chat.id, [newUserMessage("x".repeat(120_000)), newUserMessage("y".repeat(120_000)), pose, ...results]);
	return chat.id;
}

function deps(summarize: NonNullable<CompactionDeps["summarize"]>): CompactionDeps {
	return { chatStore, engine: { model: { provider: "faux", id: "test" } } as never, modelId: "faux:test", kind: "teach", thresholdTokens: 40_000, systemPromptTokens: 0, summarize };
}

async function dismiss(id: string, toolCallId = "q") {
	const request = new Request("http://test/dismiss", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: { type: "dismiss", toolCallId, answer: dismissal } }) });
	return dismissPOST({ request, params: { id } } as never);
}

async function read(id: string) {
	const record = (await chatStore.getChat(id))!;
	const results = record.messages.filter((m): m is LhMessage & ToolResultMessage => m.role === "toolResult");
	return { record, results };
}

async function assertDismissed(id: string, count = 1) {
	const { record, results } = await read(id);
	assert.equal(results.length, count, "one terminal result per call");
	for (const result of results) assert.deepEqual(result.details, dismissal);
	assert.equal(danglingQuestionOf(record.messages), null, "compaction cannot reopen a dismissed question");
	const marker = activeCompactionOf(record.messages)!;
	assert.ok(marker);
	assert.ok(keptIndexFor(record.messages, marker) >= 0, "the marker references a surviving message");
	assert.equal(record.turns?.filter((turn) => turn.messageId === marker.id).length, 1);
	assert.equal((await dismiss(id)).status, 400, "a retry cannot duplicate the dismissal");
	return results;
}

async function providerResults(id: string, input = { type: "text", text: "Continue teaching." } as Parameters<typeof handleChatInput>[1]) {
	const calls: ToolResultMessage[][] = [];
	const faux = createFauxCore({});
	faux.setResponses([(context) => {
		calls.push(context.messages.filter((m): m is ToolResultMessage => m.role === "toolResult"));
		return fauxAssistantMessage("Understood.");
	}]);
	assert.equal((await handleChatInput(id, input, { engine: { model: faux.getModel(), streamFn: faux.streamSimple } })).status, 200);
	const run = runningTurn(id);
	if (run) await new Response(run.subscribe()).text();
	assert.equal(calls.length, 1, "the next provider request runs exactly once");
	return calls[0]!;
}

for (const mode of ["idle kick", "cold admission"] as const) {
	it("concurrent dismissal survives " + mode + " and reopen", { timeout: 15_000 }, async () => {
		const id = await seed();
		const started = deferred(), release = deferred();
		let run: Promise<unknown>;
		try {
			if (mode === "cold admission") {
				services().upkeep = true;
				configureBackgroundRuns({ run: async (request) => {
					assert.equal(request.kind, "compact");
					assert.equal(request.chatId, id);
					started.resolve();
					await release.promise;
					return { text: "Earlier history.", state: { kind: "compact" }, capped: false, steps: [{ step: 1, model: "faux:test", usage, finishReason: "stop", tools: "" }] };
				} });
				run = providerResults(id, { type: "continue" });
			} else {
				kickCompaction(() => deps(async () => { started.resolve(); await release.promise; return { summary: "Earlier history.", usage }; }), id);
				run = awaitCompaction(id);
			}
			await started.promise;
			assert.equal(await isTurnRunning(id), false);
			assert.equal((await dismiss(id)).status, 200);
			const before = (await read(id)).results;
			release.resolve();
			await run;
			assert.deepEqual(await assertDismissed(id), before, "the answer identity and details do not change");
			await closeChatRuntime(id);
			assert.deepEqual(await assertDismissed(id), before);
			assert.equal((await handleChatInput(id, { type: "answer", toolCallId: "q", answer })).status, 400, "a stale answer cannot replace a dismissal");
			services().upkeep = false;
			const actual = await providerResults(id);
			assert.equal(actual.length, 1);
			assert.deepEqual(actual[0]!.details, dismissal);
		} finally {
			release.resolve();
			services().upkeep = false;
		}
	});
}

for (const tail of ["large input", "prior summary"] as const) {
	{
		it("keeps parallel questions before " + tail, { timeout: 15_000 }, async () => {
			const id = await seed(true);
			let summaries = 0;
			const largeSummary = deps(async () => { summaries++; return { summary: "z".repeat(84_000), usage }; });
			if (tail === "prior summary") await ensureCompacted(largeSummary, id);
			else await chatStore.saveMessages(id, [newUserMessage("z".repeat(84_000))]);
			const started = deferred(), release = deferred();
			let capturedPrompt = "";
			const run = ensureCompacted(deps(async (prompt) => {
				capturedPrompt = prompt;
				started.resolve(); await release.promise;
				return { summary: "Earlier history.", usage };
			}), id);
			await started.promise;
			assert.equal((await dismiss(id)).status, 200);
			assert.equal(danglingQuestionOf((await read(id)).record.messages)?.toolCallId, "q2");
			assert.equal((await dismiss(id, "q2")).status, 200);
			release.resolve(); await run;
			assert.ok(!capturedPrompt.includes("Question posed"), "a pending placeholder cannot enter the stale summary span");
			if (tail === "prior summary") assert.ok(capturedPrompt.includes("prior compaction summary"));
			await assertDismissed(id, 2);
			await closeChatRuntime(id);
			await assertDismissed(id, 2);
			const actual = await providerResults(id);
			assert.deepEqual(actual.map((r) => r.toolCallId), ["q", "q2"]);
			for (const result of actual) assert.deepEqual(result.details, dismissal);
			assert.equal(summaries, tail === "prior summary" ? 1 : 0);
		});
	}
}

it("a pinned oversized tail stops repeated summaries without dropping the question", async () => {
	const id = await seed();
	let summaries = 0;
	const options = deps(async () => { summaries++; return { summary: "z".repeat(84_000), usage }; });
	await ensureCompacted(options, id);
	await ensureCompacted(options, id);
	const before = (await read(id)).record;
	assert.equal(activeCompactionOf(before.messages)!.details.firstKeptMessageId, "pose");
	await ensureCompacted(options, id);
	assert.equal(summaries, 2);
	assert.deepEqual((await read(id)).record.messages, before.messages);
	assert.equal(danglingQuestionOf(before.messages)?.toolCallId, "q");
});

it("summary failure preserves a concurrent dismissal and retry reads the answer", async () => {
	const id = await seed();
	const started = deferred(), release = deferred();
	const run = ensureCompacted(deps(async () => { started.resolve(); await release.promise; throw new Error("expected summary failure"); }), id);
	await started.promise;
	assert.equal((await dismiss(id)).status, 200);
	const before = (await read(id)).results;
	release.resolve(); await run;
	assert.deepEqual((await read(id)).results, before);
	assert.equal(activeCompactionOf((await read(id)).record.messages), null);
	await ensureCompacted(deps(async (prompt) => {
		assert.ok(!prompt.includes("Question posed"));
		return { summary: "Earlier history.", usage };
	}), id);
	assert.deepEqual(await assertDismissed(id), before);
});

it("an ordinary answer waits for compaction and the provider receives that answer", { timeout: 15_000 }, async () => {
	const id = await seed();
	const started = deferred(), release = deferred(), readStarted = deferred();
	kickCompaction(() => deps(async () => { started.resolve(); await release.promise; return { summary: "Earlier history.", usage }; }), id);
	await started.promise;
	const oldStore = stores.chatStore;
	try {
		services().upkeep = true;
		stores.chatStore = { ...chatStore, getChat: async (chatId) => {
			const record = await chatStore.getChat(chatId);
			readStarted.resolve();
			return record;
		} };
		const run = providerResults(id, { type: "answer", toolCallId: "q", answer });
		await readStarted.promise;
		await setImmediate();
		assert.equal((await read(id)).results[0]!.details, null, "answer stays behind the compaction gate");
		release.resolve();
		const actual = await run;
		assert.equal(actual.length, 1);
		assert.deepEqual(actual[0]!.details, answer, "the provider receives the graded answer, not a stale dismissal or placeholder");
		assert.deepEqual(actual[0]!.content, [{ type: "text", text: JSON.stringify({ kind: "quiz", answers: [{ index: 1, label: "A" }], correct: true, thinking: "A fits." }) }]);
		assert.equal((await read(id)).results.length, 1);
	} finally {
		release.resolve();
		stores.chatStore = oldStore;
		services().upkeep = false;
	}
});

it("a natural quiz settlement kick preserves a dismissal during its summary", { timeout: 15_000 }, async () => {
	const chat = chatStore.createChat("natural settlement kick");
	chats.push(chat.id);
	await chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	const started = deferred(), release = deferred();
	try {
		services().upkeep = true;
		configureBackgroundRuns({ run: async (request) => {
			assert.equal(request.kind, "compact");
			assert.equal(request.chatId, chat.id);
			started.resolve(); await release.promise;
			return { text: "Earlier history.", state: { kind: "compact" }, capped: false, steps: [{ step: 1, model: "faux:test", usage, finishReason: "stop", tools: "" }] };
		} });
		const faux = createFauxCore({ tokenSize: { min: 50_000, max: 50_000 } });
		faux.setResponses([fauxAssistantMessage([fauxText("x".repeat(200_000)), fauxToolCall("quiz", question, { id: "q" })], { stopReason: "toolUse" })]);
		assert.equal((await handleChatInput(chat.id, { type: "text", text: "Teach me." }, { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, tools: bareQuestionTools() })).status, 200);
		const run = runningTurn(chat.id);
		if (run) await new Response(run.subscribe()).text();
		await started.promise;
		assert.equal(await isTurnRunning(chat.id), false);
		assert.equal((await dismiss(chat.id)).status, 200);
		release.resolve(); await awaitCompaction(chat.id);
		await assertDismissed(chat.id);
		await closeChatRuntime(chat.id);
		await assertDismissed(chat.id);
	} finally {
		release.resolve();
		services().upkeep = false;
	}
});
