/**
 * The question pause with queued work, through the REAL app composition.
 *
 * A posed question must stop the run before any queued steering or job
 * result starts another model call: the original Agent.finishTurn ended
 * BEFORE the steering poll. pi-durable's native final boundary would place
 * queued inputs and start a run; the patched afterTools `parkInputs` keeps
 * them in the inbox until the learner answers. The answer's hidden
 * continuation submit then places the parked work in the reaction run, and
 * a reopen must not lose or duplicate it.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { routeEvent } from "./support-route-event.ts";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { handleChatRequest } from "../src/session/turn.ts";
import { isTurnRunning } from "../src/session/turn-liveness.ts";
import { deliverJobResult } from "../src/jobs/wake.ts";
import { buildSubagentSteer, type JobRecord } from "../src/jobs/model/types.ts";
import { chatStore } from "../src/session/store.ts";
import { jobStore } from "../src/jobs/store.ts";
import { closeChatRuntime, openChatRuntime } from "../src/session/durable.ts";
import { danglingQuestionOf } from "../src/session/model/transcript.ts";
import { buildAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/session/model/questions.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PiEngine } from "../src/platform/engines.ts";
import type { AppTool } from "../src/tools/adapter.ts";
import type { QuestionAnswerData } from "../src/session/model/questions.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const QUIZ_INPUT = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
	type: "check",
	nodeId: "planet-order",
};

type Step = FauxResponseStep;

function scripted(steps: Step[]): { engine: PiEngine; calls: string[][] } {
	const calls: string[][] = [];
	const faux = createFauxCore({});
	faux.setResponses(
		steps.map((step) => (context: { messages: unknown[] }) => {
			calls.push(context.messages.map((message) => JSON.stringify(message)));
			return typeof step === "function"
				? (step as (c: unknown, a: unknown, n: unknown, m: unknown) => unknown)(context, undefined, undefined, undefined)
				: step;
		}) as never,
	);
	return {
		engine: { model: faux.getModel(), streamFn: (model, context, options) => faux.streamSimple(model, context, options) },
		calls,
	};
}

/** A question tool that holds its result until the test releases it, so a
 *  steer or job result is provably queued behind a live run. `bad` returns
 *  the authoring-validation error shape. */
function questionTool() {
	let release!: () => void;
	let enter!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	let calls = 0;
	const tool: AppTool = {
		name: "quiz",
		description: "Pose a graded question",
		parameters: Type.Object({ question: Type.String(), bad: Type.Optional(Type.Boolean()) }),
		execute: async (_callId, args) => {
			calls++;
			const input = args as { bad?: boolean };
			if (input.bad) {
				return { content: [{ type: "text", text: "Invalid tool input: correctAnswer is required" }], isError: true };
			}
			enter();
			await gate;
			return { content: [{ type: "text", text: "Question posed" }], details: null, terminate: true };
		},
	};
	return { tool, entered, release, calls: () => calls };
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000, what = "condition"): Promise<void> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const tick = async () => {
			if (await cond()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(() => void tick(), 25);
		};
		void tick();
	});
}

function gradedAnswer(values: string[]): QuestionAnswerData {
	const input = QUIZ_INPUT;
	const options = normalizeOptions(input.options);
	const qd: QuestionData = {
		id: "call-1",
		kind: "quiz",
		question: input.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(input.correctAnswer, options).indices,
		explanation: input.explanation,
		createdAt: new Date().toISOString(),
	};
	return buildAnswer(qd, { values });
}

async function createChat(title: string) {
	const chat = await chatStore.createChat(title);
	await chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return chat;
}

async function queuedSubmissions(chatId: string): Promise<number> {
	const runtime = await openChatRuntime(chatId);
	const view = await runtime.harness.inspect(BACKGROUND_CONTEXT);
	return view.submissions.filter((submission) => submission.status === "queued").length;
}

async function pose(chatId: string, engine: PiEngine, tool: AppTool): Promise<void> {
	const ack = await handleChatRequest(post(chatId, { type: "text", text: "ask me" }), { engine, tools: { quiz: tool } });
	assert.equal(ack.status, 200, `pose ack: ${await ack.text()}`);
}

async function answer(chatId: string, engine: PiEngine, tool: AppTool, toolCallId: string): Promise<void> {
	const ack = await handleChatRequest(post(chatId, { type: "answer", toolCallId, answer: gradedAnswer(["Mercury"]) }), {
		engine,
		tools: { quiz: tool },
	});
	assert.equal(ack.status, 200, `answer ack: ${await ack.text()}`);
}

async function queueUserSteer(chatId: string, id: string, text: string): Promise<void> {
	const steerRoute = await import("../src/routes/api/chats/[id]/steer/+server.ts");
	const res = await steerRoute.POST(
		routeEvent(
			new Request(`http://test/api/chats/${chatId}/steer`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input: { type: "steer", id, text } }),
			}),
			{ id: chatId },
		),
	);
	assert.equal(res.status, 200, `steer route: ${await res.text()}`);
}

function queueJob(chatId: string): { job: JobRecord; delivered: Promise<void> } {
	const job = jobStore.createJob({ kind: "research", chatId, toolCallId: `call_job_${Date.now()}` });
	const result = { brief: "Research brief: the orbit is elliptical.", sources: [] };
	jobStore.updateJob(job.id, { result });
	return { job, delivered: deliverJobResult(buildSubagentSteer(job, result)) };
}

const createdChats: string[] = [];
after(async () => {
	for (const id of createdChats) {
		await closeChatRuntime(id).catch(() => undefined);
		await chatStore.deleteChat(id).catch(() => undefined);
	}
});

describe("durable question pause with queued work", { concurrency: false }, () => {
	it("parks a user steer and a job result, then places both in the answer run exactly once", async () => {
		const chat = await createChat("queue: steer and job");
		createdChats.push(chat.id);
		const questions = questionTool();
		const { engine, calls } = scripted([
			fauxAssistantMessage([fauxToolCall("quiz", { question: "Which planet?" }, { id: "q1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Nice work."),
		]);

		await pose(chat.id, engine, questions.tool);
		await questions.entered;
		await queueUserSteer(chat.id, "steer_u1", "please explain slowly");
		const { job, delivered } = queueJob(chat.id);
		await waitFor(async () => (await queuedSubmissions(chat.id)) === 2, 8000, "both queued inputs admitted");

		questions.release();
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the question run settles");
		assert.equal(calls.length, 1, "no model call before the learner answers");
		const parked = (await chatStore.getChat(chat.id))!;
		assert.equal(danglingQuestionOf(parked.messages)?.toolCallId, "q1");
		assert.equal(await queuedSubmissions(chat.id), 2, "both inputs stay parked");
		assert.equal(jobStore.getJob(job.id)!.status, "running", "the job result is not lost");

		await answer(chat.id, engine, questions.tool, "q1");
		await waitFor(() => calls.length === 2, 8000, "the reaction run");
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the reaction run settles");
		await delivered;

		const reaction = calls[1]!;
		assert.ok(reaction.some((content) => content.includes("please explain slowly")), "the user steer reaches the model");
		assert.ok(reaction.some((content) => content.includes("Research brief")), "the job result reaches the model");
		assert.ok(!reaction.some((content) => content.includes("[continue]")), "the bookkeeping input stays hidden");
		const settled = (await chatStore.getChat(chat.id))!;
		assert.equal(settled.messages.filter((message) => message.id === "steer_u1").length, 1, "the steer lands once");
		assert.equal(danglingQuestionOf(settled.messages), null);
		assert.equal(jobStore.getJob(job.id)!.status, "done");
		assert.equal(await queuedSubmissions(chat.id), 0, "the inbox drains into the reaction run");
	});

	it("keeps the parked work across a reopen and places it once on the answer", async () => {
		const chat = await createChat("queue: reopen");
		createdChats.push(chat.id);
		const questions = questionTool();
		const { engine, calls } = scripted([
			fauxAssistantMessage([fauxToolCall("quiz", { question: "Which planet?" }, { id: "q1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Nice work."),
		]);

		await pose(chat.id, engine, questions.tool);
		await questions.entered;
		await queueUserSteer(chat.id, "steer_u2", "hold that thought");
		await waitFor(async () => (await queuedSubmissions(chat.id)) === 1, 8000, "the steer is queued");
		questions.release();
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the question run settles");
		assert.equal(calls.length, 1);

		await closeChatRuntime(chat.id);
		await openChatRuntime(chat.id);
		assert.equal(calls.length, 1, "reopening runs nothing");
		assert.equal(await queuedSubmissions(chat.id), 1, "the parked steer survives the reopen");

		await answer(chat.id, engine, questions.tool, "q1");
		await waitFor(() => calls.length === 2, 8000, "the reaction run after the reopen");
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the reaction run settles");
		assert.ok(calls[1]!.some((content) => content.includes("hold that thought")));
		const settled = (await chatStore.getChat(chat.id))!;
		assert.equal(settled.messages.filter((message) => message.id === "steer_u2").length, 1, "placed exactly once");
	});

	it("keeps a clean question alone paused and answers it normally", async () => {
		const chat = await createChat("queue: question alone");
		createdChats.push(chat.id);
		const questions = questionTool();
		const { engine, calls } = scripted([
			fauxAssistantMessage([fauxToolCall("quiz", { question: "Which planet?" }, { id: "q1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Correct."),
		]);

		await pose(chat.id, engine, questions.tool);
		await questions.entered;
		questions.release();
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the question run settles");
		assert.equal(calls.length, 1);
		assert.equal(danglingQuestionOf((await chatStore.getChat(chat.id))!.messages)?.toolCallId, "q1");

		await answer(chat.id, engine, questions.tool, "q1");
		await waitFor(() => calls.length === 2, 8000, "the reaction run");
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the reaction run settles");
		assert.ok(calls[1]!.some((content) => content.includes('"toolCallId":"q1"')));
	});

	it("keeps the run going after an invalid question, then parks the valid retry", async () => {
		const chat = await createChat("queue: invalid sibling");
		createdChats.push(chat.id);
		const questions = questionTool();
		const { engine, calls } = scripted([
			fauxAssistantMessage([fauxToolCall("quiz", { question: "bad", bad: true }, { id: "q1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("quiz", { question: "Which planet?" }, { id: "q2" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Correct."),
		]);

		await pose(chat.id, engine, questions.tool);
		await waitFor(() => calls.length === 2, 8000, "the retry request");
		await questions.entered;
		await queueUserSteer(chat.id, "steer_u3", "queued behind the retry");
		await waitFor(async () => (await queuedSubmissions(chat.id)) === 1, 8000, "the steer is queued");
		questions.release();
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the valid question parks");
		assert.equal(calls.length, 2, "no third call before the answer");
		assert.equal(danglingQuestionOf((await chatStore.getChat(chat.id))!.messages)?.toolCallId, "q2");
		assert.equal(await queuedSubmissions(chat.id), 1);

		await answer(chat.id, engine, questions.tool, "q2");
		await waitFor(() => calls.length === 3, 8000, "the reaction run");
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the reaction run settles");
		assert.ok(calls[2]!.some((content) => content.includes("queued behind the retry")));
	});

	it("writes a dismissal and wakes no run", async () => {
		const chat = await createChat("queue: dismissal");
		createdChats.push(chat.id);
		const questions = questionTool();
		const { engine, calls } = scripted([
			fauxAssistantMessage([fauxToolCall("quiz", { question: "Which planet?" }, { id: "q1" })], { stopReason: "toolUse" }),
		]);

		await pose(chat.id, engine, questions.tool);
		await questions.entered;
		questions.release();
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the question run settles");

		const dismissRoute = await import("../src/routes/api/chats/[id]/dismiss/+server.ts");
		const res = await dismissRoute.POST(
			routeEvent(
				new Request(`http://test/api/chats/${chat.id}/dismiss`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						input: {
							type: "dismiss",
							toolCallId: "q1",
							answer: { ...gradedAnswer([]), dontKnow: true, dismissed: true },
						},
					}),
				}),
				{ id: chat.id },
			),
		);
		assert.equal(res.status, 200, `dismiss route: ${await res.text()}`);
		assert.equal(calls.length, 1, "dismissal wakes no model call");
		const record = (await chatStore.getChat(chat.id))!;
		assert.equal(danglingQuestionOf(record.messages), null);
		const result = record.messages.find((message) => message.role === "toolResult");
		assert.equal((result?.details as { dismissed?: boolean } | undefined)?.dismissed, true);
	});

	it("defers a parallel question's reaction to the last answer and places the parked steer once", async () => {
		const chat = await createChat("queue: parallel answers");
		createdChats.push(chat.id);
		const questions = questionTool();
		const { engine, calls } = scripted([
			fauxAssistantMessage(
				[
					fauxToolCall("quiz", { question: "First?" }, { id: "q1" }),
					fauxToolCall("quiz", { question: "Second?" }, { id: "q2" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Both answered."),
		]);

		await pose(chat.id, engine, questions.tool);
		await waitFor(() => questions.calls() === 2, 8000, "both questions posed");
		await queueUserSteer(chat.id, "steer_u4", "queued across both answers");
		await waitFor(async () => (await queuedSubmissions(chat.id)) === 1, 8000, "the steer is queued");
		questions.release();
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the pose run settles");
		assert.equal(calls.length, 1);

		await answer(chat.id, engine, questions.tool, "q1");
		await waitFor(async () => (await chatStore.getChat(chat.id))!.messages.some((m) => m.role === "toolResult" && m.toolCallId === "q1"), 8000, "the first answer lands");
		assert.equal(calls.length, 1, "a sibling question defers the reaction");
		assert.equal(danglingQuestionOf((await chatStore.getChat(chat.id))!.messages)?.toolCallId, "q2");
		assert.equal(await queuedSubmissions(chat.id), 1, "the steer waits for the last answer");

		await answer(chat.id, engine, questions.tool, "q2");
		await waitFor(() => calls.length === 2, 8000, "the one reaction run");
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the reaction run settles");
		const reaction = calls[1]!;
		assert.ok(reaction.some((content) => content.includes("queued across both answers")));
		const record = (await chatStore.getChat(chat.id))!;
		assert.equal(record.messages.filter((message) => message.id === "steer_u4").length, 1, "placed exactly once");
		assert.equal(danglingQuestionOf(record.messages), null);
	});
});
