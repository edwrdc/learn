/**
 * Foreground recovery (pi-durable foreground unit C completion).
 *
 * A run interrupted mid-generation must resume after the database/process
 * reopened with no new learner input, then apply the app settle services
 * exactly once (TurnUsage with the admitted turn's id/provenance, plan
 * blocks, notifications, release of busy/handle). The reattach SSE must show
 * the recovered run's committed work before it closes. A bootstrap that
 * cannot rebuild the run (missing model binding) must fail closed: no
 * scheduling, no destroyed input, and a later reopen resumes it.
 *
 * The "process death" is a real Harness close mid-generation, then a fresh
 * open — the same seam tests/durable-background.test.ts uses.
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
	type FauxResponseFactory,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fg-recovery-"));
process.env.LH_DATA_DIR = TMP;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { chatStore } = await import("../src/session/store.ts");
const { appendMessages, closeChatRuntime, openChatRuntime, peekChatRuntime, readEntries } = await import(
	"../src/session/durable.ts"
);
const { foregroundEngineOverride, handleChatRequest } = await import("../src/session/turn.ts");
await import("./support-durable.ts");
const { runningTurn } = await import("../src/session/turn-runs.ts");
const { isTurnRunning } = await import("../src/session/turn-liveness.ts");
const { readTurn } = await import("../src/session/turn-service.ts");
const { subscribe } = await import("../src/platform/model/events.ts");
const { danglingQuestionOf } = await import("../src/session/model/transcript.ts");
const { buildAnswer, normalizeOptions, resolveCorrect } = await import("../src/session/model/questions.ts");
type QuestionData = import("../src/session/model/questions.ts").QuestionData;
type PiEngine = import("../src/platform/engines.ts").PiEngine;
type LhMessage = import("../src/session/model/transcript.ts").LhMessage;

const PLAN_CALL = { mermaid: "graph TD\n  primitives[Number primitives] --> operators[Arithmetic operators]" };
const COMPACTION_ID = "msg_compaction_probe";
const QUIZ_INPUT = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
	type: "check",
	nodeId: "primitives",
};

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

function fauxEngine(steps: FauxResponseStep[]): { engine: PiEngine; readonly calls: number } {
	let calls = 0;
	const faux = createFauxCore({});
	faux.setResponses(
		steps.map(
			(step) =>
				((...args: Parameters<FauxResponseFactory>) => {
					calls++;
					return typeof step === "function" ? step(...args) : step;
				}) as FauxResponseStep,
		) as never,
	);
	return {
		engine: { model: faux.getModel(), streamFn: faux.streamSimple },
		get calls() {
			return calls;
		},
	};
}

/** A model call that never resolves until its abort signal fires. */
function hangUntilAborted(): FauxResponseStep {
	return ((_context: unknown, options?: { signal?: AbortSignal }) =>
		new Promise<AssistantMessage>((resolve) => {
			const signal = options?.signal;
			const finish = () => resolve(fauxAssistantMessage("interrupted"));
			if (signal?.aborted) finish();
			else signal?.addEventListener("abort", finish, { once: true });
		})) as unknown as FauxResponseStep;
}

/** A model call held open until the test releases it (deterministic
 *  reattach timing). */
function gatedStep(gate: Promise<void>, message: AssistantMessage): FauxResponseStep {
	return (async () => {
		await gate;
		return message;
	}) as FauxResponseStep;
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10000, what = "condition"): Promise<void> {
	const started = Date.now();
	for (;;) {
		if (await cond()) return;
		if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function createChat(title: string) {
	const chat = await chatStore.createChat(title);
	await chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	createdChats.push(chat.id);
	return chat;
}

/** Put the chat in the TEACH phase: a committed probe_done call is the
 *  phase seam the plan/question tools hang off. A compaction marker sits
 *  between it and the turn, so the active view is a SUFFIX of the full
 *  transcript — the recovered view boundary must be an entry id, not a
 *  count of the whole history. */
async function seedProbeDone(chatId: string): Promise<void> {
	await appendMessages(chatId, [
		{ id: "u_probe", role: "user", content: "I know some arithmetic.", timestamp: 1 } as never,
		{
			id: "a_probe",
			role: "assistant",
			content: [{ type: "toolCall", id: "call-probe", name: "probe_done", arguments: {} }],
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			stopReason: "toolUse",
			timestamp: 2,
		} as never,
		{
			id: "r_probe",
			role: "toolResult",
			toolCallId: "call-probe",
			toolName: "probe_done",
			content: [{ type: "text", text: "Probe complete." }],
			details: null,
			isError: false,
			timestamp: 3,
		} as never,
		{
			id: COMPACTION_ID,
			role: "custom",
			customType: "compaction",
			content: "## Compacted history\n\nProbe summary.",
			display: true,
			details: { firstKeptMessageId: "u_probe", tokensBefore: 10, at: new Date().toISOString() },
			timestamp: 4,
		} as never,
	]);
}

function gradedAnswer(values: string[]) {
	const options = normalizeOptions(QUIZ_INPUT.options);
	const qd: QuestionData = {
		id: "call-q1",
		kind: "quiz",
		question: QUIZ_INPUT.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(QUIZ_INPUT.correctAnswer, options).indices,
		explanation: QUIZ_INPUT.explanation,
		createdAt: new Date().toISOString(),
	};
	return buildAnswer(qd, { values });
}

function eventsOf(body: string): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const line of body.split("\n")) {
		if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
		out.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
	}
	return out;
}

function userTexts(messages: readonly LhMessage[]): string[] {
	return messages
		.filter((message) => (message as { role?: string }).role === "user")
		.map((message) => (typeof message.content === "string" ? message.content : ""));
}

const createdChats: string[] = [];
after(async () => {
	for (const id of createdChats) await closeChatRuntime(id).catch(() => undefined);
});

describe("foreground run recovery", { concurrency: false }, () => {
	it("resumes a mid-generation run and settles once, then answers the resumed question", async () => {
		const chat = await createChat("Recovery: mid-generation");
		await seedProbeDone(chat.id);

		// Turn 1: a real tool round (plan_init persists a plan and commits its
		// result), then a model call that hangs — the process dies there.
		const first = fauxEngine([
			fauxAssistantMessage([fauxToolCall("plan_init", PLAN_CALL, { id: "call-plan" })], { stopReason: "toolUse" }),
			hangUntilAborted(),
		]);
		foregroundEngineOverride.current = first.engine;
		const ack = await handleChatRequest(post(chat.id, { type: "text", text: "teach me" }), { engine: first.engine });
		assert.equal(ack.status, 200);
		await waitFor(async () => {
			const record = await chatStore.getChat(chat.id);
			return (
				record?.messages.some(
					(m) =>
						(m as { role?: string }).role === "toolResult" &&
						(m as { toolCallId?: string }).toolCallId === "call-plan",
				) ?? false
			);
		}, 10000, "the pre-crash plan_init tool round committed");
		const beforeCrash = (await chatStore.getChat(chat.id))!;
		const turn = (await readTurn(await openChatRuntime(chat.id)))!;
		assert.equal(turn.settle, "running", "the admission descriptor is durable");
		assert.equal(turn.phase, "teach", "the admission phase is stored");
		assert.equal(beforeCrash.messages.filter((m) => (m as { role?: string }).role === "user").length, 2);

		// Process death mid-generation: close the Harness (storage included).
		await closeChatRuntime(chat.id);
		assert.equal(foregroundEngineOverride.current, first.engine);

		// The next process rebuilds the engine from the descriptor and the
		// bootstrap reattaches the view BEFORE resume. This generation is
		// gated so the test can attach first.
		let releaseResumed!: () => void;
		const resumedGate = new Promise<void>((resolve) => (releaseResumed = resolve));
		const resumed = fauxEngine([
			gatedStep(
				resumedGate,
				fauxAssistantMessage([fauxToolCall("quiz", QUIZ_INPUT, { id: "call-q1" })], { stopReason: "toolUse" }),
			),
		]);
		foregroundEngineOverride.current = resumed.engine;
		const settledEvents: string[] = [];
		const unsubscribe = subscribe((event) => {
			if (event.type === "turn-settled" && event.chatId === chat.id) settledEvents.push(event.type);
		});
		try {
			await openChatRuntime(chat.id);
			const handle = runningTurn(chat.id);
			assert.ok(handle, "the recovered run reattaches through the turn registry");
			const wire = new Response(handle.subscribe()).text();
			releaseResumed();
			const body = await wire;
			const events = eventsOf(body);
			// The recovered committed work replays (the pre-crash plan_init
			// round), then the resumed generation's question pose.
			const toolResults = events.filter((event) => event.type === "turn_end") as Array<{
				toolResults: Array<{ toolName?: string }>;
			}>;
			assert.ok(
				toolResults.some((event) => event.toolResults.some((result) => result.toolName === "plan_init")),
				"the recovered view shows the committed pre-crash tool step",
			);
			assert.ok(
				toolResults.some((event) => event.toolResults.some((result) => result.toolName === "quiz")),
				"the resumed generation's question pose landed on the same wire",
			);
			assert.equal(resumed.calls, 1, "the committed plan_init step was NOT requested again");
			assert.ok(
				!events.some((event) => event.type === "message_start" && (event.message as { id?: string }).id === COMPACTION_ID),
				"the recovered replay starts after the run's admission boundary (no pre-run marker replay)",
			);
			assert.ok(body.endsWith("data: [DONE]\n\n"), "the recovered view closes at settle");

			await waitFor(async () => !(await isTurnRunning(chat.id)), 10000, "the recovered turn settles");
			assert.equal(runningTurn(chat.id), undefined, "no handle survives the recovered settle");

			const record = (await chatStore.getChat(chat.id))!;
			assert.equal(danglingQuestionOf(record.messages)?.toolCallId, "call-q1", "the resumed question is pending");
			assert.deepEqual(userTexts(record.messages), ["I know some arithmetic.", "teach me"], "exactly one input, no duplicate");
			const planCalls = record.messages.filter(
				(m) =>
					(m as { role?: string }).role === "assistant" &&
					JSON.stringify((m as { content?: unknown }).content).includes("plan_init"),
			);
			assert.equal(planCalls.length, 1, "the committed pre-crash model step exists exactly once");
			const planBlocks = record.messages.filter(
				(m) => (m as { customType?: string }).customType === "plan-block",
			);
			assert.equal(planBlocks.length, 1, "the settle emitted the plan block once");
			assert.equal(
				(planBlocks[0] as { details?: { planCallId?: string } }).details?.planCallId,
				"call-plan",
				"the plan block presents the pre-crash plan_init",
			);

			const usage = (record.turns ?? []).filter((entry) => entry.id === turn.turnId);
			assert.equal(usage.length, 1, "one TurnUsage for the admitted turn id");
			assert.equal(usage[0]!.model, turn.modelId, "usage keeps the admitted model provenance");
			const completedSteps = usage[0]!.steps.length;
			const runAssistants = (await readEntries(await openChatRuntime(chat.id)))
				.slice(turn.baseEntryCount)
				.map((entry) => entry.model?.[0] as { role?: string; stopReason?: string } | undefined)
				.filter((message) => message?.role === "assistant");
			assert.equal(
				completedSteps,
				runAssistants.filter((message) => message!.stopReason !== "aborted").length,
				"every completed attempt is billed once, and no aborted attempt is",
			);

			const stored = (await readTurn(await openChatRuntime(chat.id)))!;
			assert.equal(stored.settle, "settled", "the settle is durably marked");
			assert.deepEqual(settledEvents, ["turn-settled"], "exactly one lifecycle notification");

			// Repeated recovery is idempotent: no handle, no services, no spend.
			const callsBeforeReopen = resumed.calls;
			await closeChatRuntime(chat.id);
			await openChatRuntime(chat.id);
			assert.equal(runningTurn(chat.id), undefined, "a settled turn is not recovered again");
			assert.equal(resumed.calls, callsBeforeReopen, "a settled turn makes no model call");
			const reopened = (await chatStore.getChat(chat.id))!;
			assert.equal(
				(reopened.turns ?? []).filter((entry) => entry.id === turn.turnId).length,
				1,
				"recovery never double-bills",
			);
			assert.equal(
				reopened.messages.filter((m) => (m as { customType?: string }).customType === "plan-block").length,
				1,
				"recovery never duplicates the plan block",
			);

			// The question the RECOVERED run posed answers normally.
			const reaction = fauxEngine([fauxAssistantMessage([fauxText("Right — Mercury it is.")])]);
			const answer = await handleChatRequest(
				post(chat.id, { type: "answer", toolCallId: "call-q1", answer: gradedAnswer(["Mercury"]) }),
				{ engine: reaction.engine },
			);
			assert.equal(answer.status, 200);
			await waitFor(async () => !(await isTurnRunning(chat.id)), 10000, "the answer reaction settles");
			assert.equal(reaction.calls, 1, "one reaction request");
			const answered = (await chatStore.getChat(chat.id))!;
			assert.equal(danglingQuestionOf(answered.messages), null, "the answer cleared the question");
			assert.ok(
				answered.messages.some(
					(m) =>
						(m as { role?: string }).role === "assistant" &&
						JSON.stringify((m as { content?: unknown }).content).includes("Mercury it is"),
				),
				"the reaction to the recovered question committed",
			);
		} finally {
			unsubscribe();
		}
	});

	it("fails the reopen closed when the run's model cannot be rebuilt, then resumes on retry", async () => {
		const chat = await createChat("Recovery: fail closed");
		await seedProbeDone(chat.id);

		const first = fauxEngine([
			fauxAssistantMessage([fauxToolCall("plan_init", PLAN_CALL, { id: "call-plan2" })], { stopReason: "toolUse" }),
			hangUntilAborted(),
		]);
		foregroundEngineOverride.current = first.engine;
		const ack = await handleChatRequest(post(chat.id, { type: "text", text: "teach me too" }), { engine: first.engine });
		assert.equal(ack.status, 200);
		await waitFor(async () => {
			const record = await chatStore.getChat(chat.id);
			return (
				record?.messages.some(
					(m) =>
						(m as { role?: string }).role === "toolResult" &&
						(m as { toolCallId?: string }).toolCallId === "call-plan2",
				) ?? false
			);
		}, 10000, "the pre-crash tool round committed");
		const turn = (await readTurn(await openChatRuntime(chat.id)))!;
		await closeChatRuntime(chat.id);
		const callsAtCrash = first.calls;

		// The missing binding: the injected faux model is not in the catalog,
		// so the descriptor's model cannot be rebuilt and scheduling must stay
		// off. A failed POST is the honest 503, and it writes nothing.
		foregroundEngineOverride.current = undefined;
		await assert.rejects(
			() => openChatRuntime(chat.id),
			/could not be restored/,
			"the open refuses instead of scheduling an uninitialized run",
		);
		assert.equal(peekChatRuntime(chat.id), undefined, "the failed runtime releases its slot");
		const refused = await handleChatRequest(post(chat.id, { type: "text", text: "third message" }));
		assert.equal(refused.status, 503, "the turn refuses honestly while recovery cannot start");
		assert.equal((await refused.json()).code, "runtime_unavailable");
		assert.equal(first.calls, callsAtCrash, "no persisted task ran before its extension existed");
		assert.equal(await isTurnRunning(chat.id), true, "the pending run stays busy while its runtime cannot start");

		// The model comes back: the same committed work resumes once.
		let releaseResumed!: () => void;
		const resumedGate = new Promise<void>((resolve) => (releaseResumed = resolve));
		const resumed = fauxEngine([
			gatedStep(
				resumedGate,
				fauxAssistantMessage([fauxToolCall("quiz", QUIZ_INPUT, { id: "call-q2" })], { stopReason: "toolUse" }),
			),
		]);
		foregroundEngineOverride.current = resumed.engine;
		await openChatRuntime(chat.id);
		const handle = runningTurn(chat.id);
		assert.ok(handle, "the retry resumes the pending run");
		const wire = new Response(handle.subscribe()).text();
		releaseResumed();
		const body = await wire;
		assert.ok(body.includes("plan_init"), "the recovered view carries the committed pre-crash step");
		await waitFor(async () => !(await isTurnRunning(chat.id)), 10000, "the retried recovery settles");

		const record = (await chatStore.getChat(chat.id))!;
		assert.deepEqual(
			userTexts(record.messages),
			["I know some arithmetic.", "teach me too"],
			"the failed open and refused POST neither orphaned nor duplicated the input",
		);
		assert.equal(danglingQuestionOf(record.messages)?.toolCallId, "call-q2", "the resumed run posed its question");
		assert.equal(resumed.calls, 1, "exactly one resumed model request");
		assert.equal((record.turns ?? []).filter((entry) => entry.id === turn.turnId).length, 1, "usage landed once");
		assert.equal(
			record.messages.filter((m) => (m as { customType?: string }).customType === "plan-block").length,
			1,
			"the plan block landed once",
		);
		assert.equal((await readTurn(await openChatRuntime(chat.id)))!.settle, "settled");
	});
});
