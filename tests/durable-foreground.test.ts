/**
 * The durable foreground turn, end to end (pi-durable migration, unit B).
 *
 * These pin the contracts the migration must preserve on the REAL runtime:
 * the question pose/answer round trip across a database close and reopen,
 * the live wire and its reattach replay, abort retaining committed partials
 * without billing them, the question stop ending a mixed round, and the
 * delete/metadata single-owner boundary.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { routeEvent } from "./support-route-event.ts";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defineExtension, defineTool, type LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { handleChatRequest } from "../src/session/turn.ts";
import "./support-durable.ts";
import { runningTurn, settledTurnResponse, abortTurn } from "../src/session/turn-runs.ts";
import { isTurnRunning } from "../src/session/turn-liveness.ts";
import { appendRunUsage } from "../src/session/turn-service.ts";
import { deliverJobResult, setTurnRunner, steerLiveChat } from "../src/jobs/wake.ts";
import { buildSubagentSteer, type ResearchResult } from "../src/jobs/model/types.ts";
import { newHandoffMessage } from "../src/session/model/transcript.ts";
import { chatStore } from "../src/session/store.ts";
import { jobStore } from "../src/jobs/store.ts";
import {
	CONTINUATION_KIND,
	appendEntries,
	appendMessages,
	closeChatRuntime,
	durableDir,
	openChatRuntime,
	readEntries,
} from "../src/session/durable.ts";
import {
	continuationSignature,
	danglingQuestionOf,
	needsContinuation,
} from "../src/session/model/transcript.ts";
import { prepareConversation, turnProfile } from "../src/session/durable-registry.ts";
import { effectiveSettings, stores } from "../src/stores.ts";
import { POST as dismissPOST } from "../src/routes/api/chats/[id]/dismiss/+server.ts";
import { buildAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/session/model/questions.ts";
import { projectView } from "../src/session/model/view.ts";
import { bareQuestionTools } from "./support-tools.ts";
import { providerEventsDir } from "../src/platform/provider-events.ts";
import { PATHS } from "../src/platform/config.ts";
import type { PiEngine } from "../src/platform/engines.ts";
import type { AppTool } from "../src/tools/adapter.ts";
import { posedPlaceholder } from "./support-tools.ts";

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

function scripted(steps: Step[]): { engine: PiEngine; calls: string[][]; roles: string[][] } {
	const calls: string[][] = [];
	const roles: string[][] = [];
	const faux = createFauxCore({});
	const wrap = (step: Step) => (context: { messages: unknown[] }) => {
		calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
		roles.push(context.messages.map((m) => (m as { role: string }).role));
		return typeof step === "function"
			? (step as (c: unknown, a: unknown, n: unknown, m: unknown) => unknown)(context, undefined, undefined, undefined)
			: step;
	};
	faux.setResponses(steps.map(wrap) as never);
	return {
		engine: {
			model: faux.getModel(),
			// A provider adapter's raw observer: pi-ai hands the parsed
			// provider payload to options.onProviderStreamEvent before it
			// normalizes it. The faux core has no wire format, so emit the
			// adapter-owned shape here; the real SSE proof lives in
			// tests/models-router.test.ts.
			streamFn: (model, context, options) => {
				void options?.onProviderStreamEvent?.({ type: "faux.raw.event", item_id: "raw-1" }, model);
				return faux.streamSimple(model, context, options);
			},
		},
		calls,
		roles,
	};
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

async function turn(chatId: string, input: unknown, engine: PiEngine, extra: object = {}): Promise<string> {
	const ack = await handleChatRequest(post(chatId, input), { engine, tools: bareQuestionTools(), ...extra });
	if (ack.status !== 200) assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
	const handle = runningTurn(chatId);
	return handle ? new Response(handle.subscribe()).text() : "";
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

async function createChat(title: string) {
	const chat = await chatStore.createChat(title);
	await chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	createdChats.push(chat.id);
	return chat;
}

function gradedAnswer(values: string[]) {
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

const createdChats: string[] = [];
after(async () => {
	for (const id of createdChats) {
		await closeChatRuntime(id).catch(() => undefined);
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
});

describe("durable foreground turn", { concurrency: false }, () => {
	it("answers a posed question after the database closed and reopened", async () => {
		const chat = await createChat("Durable: reopen answer");
		const { engine, calls } = scripted([
			fauxAssistantMessage([fauxToolCall("quiz", QUIZ_INPUT, { id: "call-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Right — Mercury it is.")]),
		]);
		await turn(chat.id, { type: "text", text: "teach me" }, engine);

		const posed = (await chatStore.getChat(chat.id))!;
		assert.equal(danglingQuestionOf(posed.messages)?.toolCallId, "call-1", "the pose is pending");
		const poseResult = posed.messages.find(
			(m) => (m as { role?: string }).role === "toolResult" && (m as { toolCallId?: string }).toolCallId === "call-1",
		);
		assert.ok(poseResult, "the pose's placeholder result is committed");

		// A fresh process reads the same database.
		await closeChatRuntime(chat.id);

		await turn(chat.id, { type: "answer", toolCallId: "call-1", answer: gradedAnswer(["Mercury"]) }, engine);
		const answered = (await chatStore.getChat(chat.id))!;
		const results = answered.messages.filter(
			(m) => (m as { role?: string }).role === "toolResult" && (m as { toolCallId?: string }).toolCallId === "call-1",
		);
		assert.equal(results.length, 1, "the answer REPLACES the pose result — one result, never a duplicate");
		assert.notEqual((results[0] as { id?: string }).id, (poseResult as { id?: string }).id, "the answer carries the answer id");
		assert.equal(danglingQuestionOf(answered.messages), null, "nothing pending after the answer");
		assert.equal(calls.length, 2, "one reaction request — the bookkeeping input is hidden");
		assert.ok(calls[1]!.join("\n").includes("Mercury"), "the model saw the graded answer as the call's result");
		assert.ok(
			answered.messages.some(
				(m) =>
					(m as { role?: string }).role === "assistant" &&
					JSON.stringify((m as { content?: unknown }).content).includes("Mercury it is"),
			),
			"the reaction was committed",
		);
		const view = projectView(answered.messages);
		const part = view
			.flatMap((m) => m.parts)
			.find((p) => p.type === "tool-quiz") as { state?: string } | undefined;
		assert.equal(part?.state, "output-available", "the answered card renders from the replaced result");
	});

	it("reattaching mid-run replays from the first event and settles once", async () => {
		const chat = await createChat("Durable: reattach");
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const faux = createFauxCore({});
		faux.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage([fauxText("Gated reply.")]);
			},
		]);
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };

		const ack = await handleChatRequest(post(chat.id, { type: "text", text: "hold" }), { engine });
		assert.equal(ack.status, 200);
		const first = new Response(runningTurn(chat.id)!.subscribe()).text();
		const second = new Response(runningTurn(chat.id)!.subscribe()).text();
		release();
		const [a, b] = await Promise.all([first, second]);
		assert.ok(a.startsWith('data: {"type":"agent_start"}'), "the first view replays the run from its start");
		assert.deepEqual(a, b, "both views see the same dialect");
		assert.ok(a.endsWith("data: [DONE]\n\n"), "the wire closes at settle");
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "settle");
		assert.equal(runningTurn(chat.id), undefined, "no handle survives settle");
		assert.equal(await settledTurnResponse().text(), 'data: {"type":"turn-settled"}\n\ndata: [DONE]\n\n');
	});

	it("abort keeps the committed partial (the assistant call) and bills nothing for it", async () => {
		const chat = await createChat("Durable: abort partial");
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const slow: AppTool = {
			name: "slow",
			description: "waits",
			parameters: Type.Object({}),
			executionMode: "sequential",
			execute: async () => {
				await gate;
				return { content: [{ type: "text" as const, text: "done" }], details: null };
			},
		};
		const { engine } = scripted([fauxAssistantMessage([fauxToolCall("slow", {}, { id: "call-s1" })], { stopReason: "toolUse" })]);
		await handleChatRequest(post(chat.id, { type: "text", text: "go" }), { engine, tools: { slow } });
		await waitFor(async () => {
			const record = await chatStore.getChat(chat.id);
			return record?.messages.some((m) => (m as { role?: string }).role === "assistant") ?? false;
		}, 8000, "the assistant entry commits before the tool round");

		assert.deepEqual(abortTurn(chat.id), { ok: true });
		release();
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "aborted settle");
		const record = (await chatStore.getChat(chat.id))!;
		const assistant = record.messages.find((m) => (m as { role?: string }).role === "assistant") as
			| { content?: Array<{ type?: string; id?: string }> }
			| undefined;
		assert.ok(assistant, "the committed partial survives the abort");
		assert.ok(
			assistant!.content?.some((b) => b.type === "toolCall" && b.id === "call-s1"),
			"the in-flight call is part of the retained partial",
		);
		assert.deepEqual(abortTurn(chat.id), { ok: false, reason: "not_running" }, "nothing left to abort");
	});

	it("per-turn usage skips an aborted attempt (the app's no-bill rule)", async () => {
		const chat = await createChat("Durable: usage");
		const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 };
		await appendMessages(chat.id, [
			{
				id: "msg_aborted",
				role: "assistant",
				content: [{ type: "text", text: "partial" }],
				api: "faux",
				provider: "faux",
				model: "faux-1",
				usage,
				stopReason: "aborted",
				timestamp: 1,
			} as never,
			{
				id: "msg_ok",
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "faux",
				provider: "faux",
				model: "faux-1",
				usage: { ...usage, input: 30, output: 4 },
				stopReason: "stop",
				timestamp: 2,
			} as never,
		]);
		await appendRunUsage(chatStore, chat.id, 0, "turn_usage_probe", "faux:faux-1");
		const record = (await chatStore.getChat(chat.id))!;
		const logged = (record.turns ?? []).find((t) => t.id === "turn_usage_probe");
		assert.ok(logged, "the usage entry landed");
		assert.equal(logged!.steps.length, 1, "only the completed attempt is billed");
		assert.equal(logged!.steps[0]!.inputTokens, 30);
		assert.equal(logged!.messageId, "msg_aborted", "provenance keys to the run's first assistant message");
	});

	it("the question stop ends a mixed round with an unoffered sibling", async () => {
		const chat = await createChat("Durable: question stop");
		const { engine } = scripted([
			fauxAssistantMessage(
				[
					fauxToolCall("quiz", QUIZ_INPUT, { id: "call-1" }),
					fauxToolCall("nope", {}, { id: "call-x" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("should never be requested")]),
		]);
		await turn(chat.id, { type: "text", text: "teach me" }, engine);
		const record = (await chatStore.getChat(chat.id))!;
		const results = record.messages.filter((m) => (m as { role?: string }).role === "toolResult");
		assert.equal(results.length, 2, "both calls resolved (the unoffered one with its error result)");
		const quiz = results.find((m) => (m as { toolCallId?: string }).toolCallId === "call-1") as { isError?: boolean };
		const sibling = results.find((m) => (m as { toolCallId?: string }).toolCallId === "call-x") as { isError?: boolean };
		assert.equal(quiz.isError, false, "the clean question stands");
		assert.equal(sibling.isError, true, "the unoffered sibling keeps its error");
		const entries = await readEntries(await import("../src/session/durable.ts").then((m) => m.openChatRuntime(chat.id)));
		const assistantEntries = entries.filter((e) => (e.model?.[0] as { role?: string } | undefined)?.role === "assistant");
		assert.equal(assistantEntries.length, 1, "the run ended at the question — no retry request");
	});

	it("the provider request honors the app's compaction cut (summary head + kept tail only)", async () => {
		const chat = await createChat("Durable: compaction cut");
		await appendMessages(chat.id, [
			{ id: "msg_u1", role: "user", content: "OLD-SECRET", timestamp: 1 } as never,
			{
				id: "msg_a1",
				role: "assistant",
				content: [{ type: "text", text: "old reply" }],
				api: "faux",
				provider: "faux",
				model: "faux-1",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
				timestamp: 2,
			} as never,
			{ id: "msg_u2", role: "user", content: "KEEP-ME", timestamp: 3 } as never,
			{
				id: "msg_marker",
				role: "custom",
				customType: "compaction",
				content: "## Compacted history\n\nSUMMARY-TEXT",
				display: true,
				details: { firstKeptMessageId: "msg_u2", tokensBefore: 1, at: new Date().toISOString() },
				timestamp: 4,
			} as never,
		]);
		const { engine, calls, roles } = scripted([fauxAssistantMessage([fauxText("ok")])]);
		await turn(chat.id, { type: "text", text: "continue" }, engine);
		assert.equal(roles[0]![0], "system", "the system prompt survives the cut");
		assert.ok(calls[0]![1]!.includes("SUMMARY-TEXT"), "the summary head follows the system prompt");
		const prompt = calls[0]!.join("\n");
		assert.ok(prompt.includes("SUMMARY-TEXT"), "the active summary renders once at the head");
		assert.equal(prompt.split("SUMMARY-TEXT").length - 1, 1, "the marker never renders twice");
		assert.ok(prompt.includes("KEEP-ME"), "the kept tail rides the request");
		assert.ok(!prompt.includes("OLD-SECRET"), "the dropped span never reaches the provider");
	});

	it("the compaction cut applies when the first kept message is a UI-only plan block", async () => {
		const chat = await createChat("Durable: cut at a plan block");
		await appendMessages(chat.id, [
			{ id: "msg_u1", role: "user", content: "OLD-SECRET", timestamp: 1 } as never,
			{ id: "msg_pb", role: "custom", customType: "plan-block", content: "", display: true, details: {}, timestamp: 2 } as never,
			{ id: "msg_u2", role: "user", content: "KEEP-ME", timestamp: 3 } as never,
			{
				id: "msg_marker",
				role: "custom",
				customType: "compaction",
				content: "## Compacted history\n\nSUMMARY-TEXT",
				display: true,
				details: { firstKeptMessageId: "msg_pb", tokensBefore: 1, at: new Date().toISOString() },
				timestamp: 4,
			} as never,
		]);
		const { engine, calls } = scripted([fauxAssistantMessage([fauxText("ok")])]);
		await turn(chat.id, { type: "text", text: "continue" }, engine);
		const prompt = calls[0]!.join("\n");
		assert.equal(prompt.split("SUMMARY-TEXT").length - 1, 1);
		assert.ok(prompt.includes("KEEP-ME"));
		assert.ok(!prompt.includes("OLD-SECRET"), "the dropped span never reaches the provider");
	});

	it("the raw provider recorder captures the durable run's stream events", async () => {
		const chat = await createChat("Durable: provider events");
		const dir = fs.mkdtempSync(path.join(PATHS.data, "provider-events-"));
		const previous = providerEventsDir.current;
		providerEventsDir.current = dir;
		process.env.LH_PROVIDER_EVENTS = "1";
		try {
			const { engine } = scripted([fauxAssistantMessage([fauxText("recorded")])]);
			await turn(chat.id, { type: "text", text: "hello" }, engine);
			const file = path.join(dir, `${chat.id}.jsonl`);
			assert.ok(fs.existsSync(file), "one JSONL per chat");
			const lines = fs.readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
			const eventLine = lines.find((line) => line.event !== undefined && line.provider === "faux");
			assert.ok(eventLine, "the provider adapter's raw event was recorded");
			assert.deepEqual(
				eventLine.event,
				{ type: "faux.raw.event", item_id: "raw-1" },
				"the observer saw the adapter-owned payload, not a normalized pi-ai event",
			);
			assert.ok(lines.some((line) => typeof line.note === "string" && line.note.includes("run start")), "the run marker records");
		} finally {
			process.env.LH_PROVIDER_EVENTS = undefined;
			providerEventsDir.current = previous;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a probe handoff never rides a live run — it wakes the teacher after the run ends", async () => {
		const chat = await createChat("Durable: handoff waits");
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const faux = createFauxCore({});
		faux.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage([fauxText("Probe done?")]);
			},
		]);
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
		let wakes = 0;
		setTurnRunner(async () => {
			wakes++;
			return 200;
		});
		await handleChatRequest(post(chat.id, { type: "text", text: "probe me" }), { engine, tools: bareQuestionTools() });
		const delivery = deliverJobResult(chat.id, newHandoffMessage(chat.id));
		await new Promise((r) => setTimeout(r, 900));
		assert.equal(wakes, 0, "the handoff waits while the run is live (it must START the teacher's run)");
		release();
		await waitFor(() => wakes > 0, 8000, "the handoff wake after settle");
		await delivery.catch(() => undefined);
		assert.equal(wakes, 1, "exactly one wake carries the handoff");
	});

	it("the foreground agent is offered only its own extension, never a live background child's", async () => {
		const chat = await createChat("Durable: extension selection");
		const runtime = await openChatRuntime(chat.id);
		const backgroundTool = defineTool({
			name: "bg_only_tool",
			description: "a live background child's tool",
			parameters: Type.Object({}),
			execute: async () => ({ output: [{ type: "text" as const, text: "bg" }] }),
		});
		runtime.registry.install(defineExtension({ name: "lh-bg-probe", tools: [backgroundTool] }));

		const faux = createFauxCore({});
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
		await prepareConversation(runtime, [], turnProfile("probe", engine, effectiveSettings()), {
			chatStore: stores.chatStore,
			graphStore: stores.graphStore,
			jobStore: stores.jobStore,
			spawn: () => undefined,
			deliver: () => undefined,
			graphNodes: () => [],
		});
		const agent = await runtime.root.agent(BACKGROUND_CONTEXT);
		const names = agent.tools.map((tool) => tool.name);
		assert.equal(names.includes("bg_only_tool"), false, "the background child's tool is not offered");
		assert.ok(names.length > 0, "the foreground phase tools are selected");
		assert.ok(
			runtime.registry.snapshot().installed().some((extension) => extension.name === "lh-bg-probe"),
			"the background extension stays installed for its own conversation",
		);
	});

	it("a second live turn replays only from its admission boundary", async () => {
		const chat = await createChat("Durable: live replay boundary");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const faux = createFauxCore({});
		faux.setResponses([
			fauxAssistantMessage([fauxText("FIRST_REPLY")]),
			(async () => {
				await gate;
				return fauxAssistantMessage([fauxText("SECOND_REPLY")]);
			}) as FauxResponseStep,
		]);
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
		await turn(chat.id, { type: "text", text: "one" }, engine);
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the first turn settles");

		const ack = await handleChatRequest(post(chat.id, { type: "text", text: "two" }), { engine });
		assert.equal(ack.status, 200);
		const wire = new Response(runningTurn(chat.id)!.subscribe()).text();
		release();
		const body = await wire;
		assert.ok(body.includes("SECOND_REPLY"), "the second turn's own reply is on its wire");
		assert.equal(body.includes("FIRST_REPLY"), false, "the earlier reply is not replayed");
	});

	it("activity bumps updatedAt for a turn, an answer and a silent dismissal", async () => {
		const chat = await createChat("Durable: updatedAt");
		await createChat("Durable: newer sibling");
		const before = (await chatStore.getChat(chat.id))!.updatedAt;
		await new Promise((resolve) => setTimeout(resolve, 5));

		const { engine } = scripted([fauxAssistantMessage([fauxText("turn reply")])]);
		await turn(chat.id, { type: "text", text: "hello" }, engine);
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the turn settles");
		const afterTurn = (await chatStore.getChat(chat.id))!.updatedAt;
		assert.notEqual(afterTurn, before, "a turn is activity");

		// Two dangling questions: answering one lands in the cheap parallel
		// terminal (no run), which must still count as activity.
		await appendMessages(chat.id, [
			{
				id: "a-two-questions",
				role: "assistant",
				content: [
					{ type: "toolCall", id: "q-a", name: "quiz", arguments: QUIZ_INPUT as never },
					{ type: "toolCall", id: "q-b", name: "quiz", arguments: QUIZ_INPUT as never },
				],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 1,
			} as never,
			posedPlaceholder("q-a"),
			posedPlaceholder("q-b"),
		]);
		await new Promise((resolve) => setTimeout(resolve, 5));
		const afterSeed = (await chatStore.getChat(chat.id))!.updatedAt;
		const answerAck = await handleChatRequest(
			post(chat.id, { type: "answer", toolCallId: "q-a", answer: gradedAnswer(["Mercury"]) }),
		);
		assert.equal(answerAck.status, 200);
		const afterAnswer = (await chatStore.getChat(chat.id))!.updatedAt;
		assert.notEqual(afterAnswer, afterSeed, "an answer is activity");

		await new Promise((resolve) => setTimeout(resolve, 5));
		const dismissAck = await dismissPOST(
			routeEvent(
				new Request(`http://test/api/chats/${chat.id}/dismiss`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						input: { type: "dismiss", toolCallId: "q-b", answer: { ...gradedAnswer(["Venus"]), dismissed: true } },
					}),
				}),
				{ id: chat.id },
			),
		);
		assert.equal(dismissAck.status, 200);
		const afterDismiss = (await chatStore.getChat(chat.id))!.updatedAt;
		assert.notEqual(afterDismiss, afterAnswer, "a silent dismissal is activity");
		assert.equal((await chatStore.listChats())[0]!.id, chat.id, "activity moves the chat up the sidebar");
	});

	it("a metadata touch failure never fails a committed cheap answer or dismissal", async () => {
		const chat = await createChat("Durable: touch failure");
		await appendMessages(chat.id, [
			{
				id: "a-touch-questions",
				role: "assistant",
				content: [
					{ type: "toolCall", id: "q-touch-a", name: "quiz", arguments: QUIZ_INPUT as never },
					{ type: "toolCall", id: "q-touch-b", name: "quiz", arguments: QUIZ_INPUT as never },
				],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 1,
			} as never,
			posedPlaceholder("q-touch-a"),
			posedPlaceholder("q-touch-b"),
		]);
		const originalTouch = chatStore.touchChat;
		try {
			chatStore.touchChat = async () => {
				throw new Error("metadata unavailable");
			};
			const answerAck = await handleChatRequest(
				post(chat.id, { type: "answer", toolCallId: "q-touch-a", answer: gradedAnswer(["Mercury"]) }),
			);
			assert.equal(answerAck.status, 200, "the committed cheap answer acknowledges success");
			const answered = (await chatStore.getChat(chat.id))!.messages.filter(
				(message) => (message as { toolCallId?: string }).toolCallId === "q-touch-a",
			);
			assert.equal(answered.length, 1, "the answer is committed once");

			const dismissAck = await dismissPOST(
				routeEvent(
					new Request(`http://test/api/chats/${chat.id}/dismiss`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							input: { type: "dismiss", toolCallId: "q-touch-b", answer: { ...gradedAnswer(["Venus"]), dismissed: true } },
						}),
					}),
					{ id: chat.id },
				),
			);
			assert.equal(dismissAck.status, 200, "the committed dismissal acknowledges success");
			const dismissed = (await chatStore.getChat(chat.id))!.messages.filter(
				(message) => (message as { toolCallId?: string }).toolCallId === "q-touch-b",
			);
			assert.equal(dismissed.length, 1, "the dismissal is committed once");
			assert.equal(danglingQuestionOf((await chatStore.getChat(chat.id))!.messages), null, "both calls resolved");
		} finally {
			chatStore.touchChat = originalTouch;
		}
	});

	it("a pending question owes no continuation; explicit continue cannot bypass the pause", async () => {
		const chat = await createChat("Durable: question pause");
		const { engine } = scripted([
			fauxAssistantMessage([fauxToolCall("quiz", QUIZ_INPUT, { id: "call-pending" })], { stopReason: "toolUse" }),
		]);
		await turn(chat.id, { type: "text", text: "teach me" }, engine);
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the pose settles");

		const posed = (await chatStore.getChat(chat.id))!;
		assert.equal(needsContinuation(posed.messages), false, "a pending question is not a consumed result");
		const runtime = await openChatRuntime(chat.id);
		const entriesBefore = (await readEntries(runtime)).length;

		const phantom = scripted([fauxAssistantMessage([fauxText("PHANTOM_REPLY")])]);
		const ack = await handleChatRequest(post(chat.id, { type: "continue" }), { engine: phantom.engine });
		assert.equal(ack.status, 200);
		assert.ok((await ack.text()).includes("turn-settled"), "the cheap terminal, not a run");
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(phantom.calls.length, 0, "no provider request");
		assert.equal((await readEntries(runtime)).length, entriesBefore, "no new native input");

		const reaction = scripted([fauxAssistantMessage([fauxText("ANSWER_REACTION")])]);
		const answerAck = await handleChatRequest(
			post(chat.id, { type: "answer", toolCallId: "call-pending", answer: gradedAnswer(["Mercury"]) }),
			{ engine: reaction.engine },
		);
		assert.equal(answerAck.status, 200, "the real answer is accepted");
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the reaction settles");
		assert.equal(reaction.calls.length, 1, "exactly one reaction request");
		assert.equal(
			reaction.calls[0]!.join("\n").includes("[continue]"),
			false,
			"the hidden continuation input never reaches the provider",
		);
		const answered = (await chatStore.getChat(chat.id))!;
		assert.equal(danglingQuestionOf(answered.messages), null, "nothing pending");
		assert.equal(JSON.stringify(answered.messages).includes("PHANTOM_REPLY"), false, "no phantom reply was committed");
	});

	it("a learner message that is exactly the continuation sentinel still reaches the provider", async () => {
		const chat = await createChat("Durable: literal continuation sentinel");
		const { engine, calls } = scripted([fauxAssistantMessage([fauxText("literal accepted")])]);
		await turn(chat.id, { type: "text", text: "[continue]" }, engine);
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the turn settles");
		assert.equal(calls.length, 1);
		assert.ok(
			calls[0]!.some((content) => content === JSON.stringify("[continue]")),
			"the learner's literal string reaches the provider",
		);
	});

	it("a legacy structured learner text equal to the continuation sentinel survives the next request", async () => {
		const chat = await createChat("Durable: structured continuation sentinel");
		await appendMessages(chat.id, [
			{
				id: "u-structured-sentinel",
				role: "user",
				content: [{ type: "text", text: "[continue]" }],
				timestamp: 1,
			} as never,
		]);
		const { engine, calls } = scripted([fauxAssistantMessage([fauxText("structured accepted")])]);
		await turn(chat.id, { type: "text", text: "after the legacy message" }, engine);
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the turn settles");
		assert.ok(
			calls[0]!.some((content) => content === JSON.stringify([{ type: "text", text: "[continue]" }])),
			"the imported structured learner message reaches the provider",
		);
	});

	it("a legacy structured hidden continuation entry is filtered by kind", async () => {
		const chat = await createChat("Durable: legacy structured hidden");
		await appendEntries(chat.id, [
			{
				kind: CONTINUATION_KIND,
				model: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: "[continue]" }],
						timestamp: 1,
					},
				],
			},
		]);
		const { engine, calls } = scripted([fauxAssistantMessage([fauxText("ok")])]);
		await turn(chat.id, { type: "text", text: "visible" }, engine);
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the turn settles");
		assert.equal(
			calls[0]!.some((content) => content === JSON.stringify([{ type: "text", text: "[continue]" }])),
			false,
			"the legacy structured hidden input never reaches the provider",
		);
		assert.ok(calls[0]!.some((content) => content === JSON.stringify("visible")), "the learner's text survives");
	});

	it("a learner and the hidden continuation with the same text drop only the hidden input", async () => {
		const chat = await createChat("Durable: identical continuation text");
		await appendMessages(chat.id, [
			{
				id: "u-identical-sentinel",
				role: "user",
				content: [{ type: "text", text: "[continue]" }],
				timestamp: 7,
			} as never,
		]);
		const { engine, calls } = scripted([
			fauxAssistantMessage([fauxToolCall("quiz", QUIZ_INPUT, { id: "call-identical" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("answered")]),
		]);
		await turn(chat.id, { type: "text", text: "pose" }, engine);
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the pose settles");
		await turn(
			chat.id,
			{ type: "answer", toolCallId: "call-identical", answer: gradedAnswer(["Mercury"]) },
			engine,
		);
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the reaction settles");
		const reaction = calls[1]!;
		assert.equal(
			reaction.filter((content) => content === JSON.stringify([{ type: "text", text: "[continue]" }])).length,
			1,
			"the learner's structured message survives",
		);
		assert.equal(
			reaction.some((content) => content === JSON.stringify("[continue]")),
			false,
			"the hidden continuation input is gone",
		);
	});

	it("a missing generation checkpoint fails the request closed instead of using the latest context", async () => {
		const chat = await createChat("Durable: missing request checkpoint");
		const runtime = await openChatRuntime(chat.id);
		const originalGetTask = runtime.harness.getTask;
		runtime.harness.getTask = (async () => undefined) as typeof runtime.harness.getTask;
		try {
			const { engine, calls } = scripted([fauxAssistantMessage([fauxText("LATEST_CONTEXT_LEAK")])]);
			const ack = await handleChatRequest(post(chat.id, { type: "text", text: "must not reach the provider" }), {
				engine,
			});
			assert.equal(ack.status, 200);
			await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the faulted request releases the turn");
			assert.equal(calls.length, 0, "no provider request without the request cutoff");
			assert.equal(
				JSON.stringify((await chatStore.getChat(chat.id))!.messages).includes("LATEST_CONTEXT_LEAK"),
				false,
				"no model answer from the latest-context fallback",
			);
		} finally {
			runtime.harness.getTask = originalGetTask;
		}
	});

	for (const failure of ["task checkpoint", "request context"] as const) {
		it(`a ${failure} read failure stops the provider request`, async () => {
			const chat = await createChat(`Durable: ${failure} read failure`);
			const runtime = await openChatRuntime(chat.id);
			const originalGetTask = runtime.harness.getTask;
			const originalContext = runtime.root.context;
			if (failure === "task checkpoint") {
				runtime.harness.getTask = async () => {
					throw new Error("forced checkpoint read failure");
				};
			} else {
				runtime.root.context = async (context, options) => {
					if (options?.at !== undefined) throw new Error("forced context read failure");
					return originalContext.call(runtime.root, context, options);
				};
			}
			try {
				const { engine, calls } = scripted([fauxAssistantMessage([fauxText("UNFILTERED_REQUEST_LEAK")])]);
				const ack = await handleChatRequest(post(chat.id, { type: "text", text: "do not send without provenance" }), {
					engine,
				});
				assert.equal(ack.status, 200);
				await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the failed request releases the turn");
				assert.equal(calls.length, 0, "no provider request when provenance cannot be read");
				assert.equal(
					JSON.stringify((await chatStore.getChat(chat.id))!.messages).includes("UNFILTERED_REQUEST_LEAK"),
					false,
					"no model reply from an unfiltered request",
				);
			} finally {
				runtime.harness.getTask = originalGetTask;
				runtime.root.context = originalContext;
			}
		});
	}

	it("a failed generation that commits nothing does not re-arm the auto-continuation", async () => {
		const chat = await createChat("Durable: failure loop");
		await appendMessages(chat.id, [
			{ id: "u-before", role: "user", content: "hello", timestamp: 1 } as never,
			{
				id: "a-dispatched",
				role: "assistant",
				content: [{ type: "toolCall", id: "job-call", name: "research", arguments: {} as never }],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 1,
			} as never,
			{
				id: "r-dispatched",
				role: "toolResult",
				toolCallId: "job-call",
				toolName: "research",
				content: [{ type: "text", text: "Dispatched." }],
				details: "Dispatched.",
				isError: false,
				timestamp: 1,
			} as never,
		]);
		const tail = (await chatStore.getChat(chat.id))!.messages;
		assert.equal(needsContinuation(tail), true, "the record owes a continuation");
		const signature = continuationSignature(tail);

		const faux = createFauxCore({});
		const failing: PiEngine = {
			model: faux.getModel(),
			streamFn: () => {
				throw new Error("provider unavailable");
			},
		};
		const ack = await handleChatRequest(post(chat.id, { type: "continue" }), { engine: failing });
		assert.equal(ack.status, 200);
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the failed run settles");
		const after = (await chatStore.getChat(chat.id))!.messages;
		assert.equal(after.length, tail.length, "the failed run committed no entry");
		assert.equal(needsContinuation(after), true, "the record still owes the reaction");
		assert.equal(continuationSignature(after), signature, "no progress: the client must not re-send forever");
	});

	it("a steer or job result during settle never starts an unmanaged run", async () => {
		const chat = await createChat("Durable: settle admission");
		let releaseSettle!: () => void;
		const settleGate = new Promise<void>((resolve) => (releaseSettle = resolve));
		let requests = 0;
		let wake = 0;
		setTurnRunner(async () => {
			wake++;
			return 200;
		});
		const faux = createFauxCore({});
		faux.setResponses([
			(() => fauxAssistantMessage([fauxText("first reply")])) as FauxResponseStep,
			(() => fauxAssistantMessage([fauxText("fallback reply")])) as FauxResponseStep,
		]);
		const engine: PiEngine = {
			model: faux.getModel(),
			streamFn: (model, context, options) => {
				requests++;
				return faux.streamSimple(model, context, options);
			},
		};
		const originalAppendUsage = chatStore.appendTurnUsage;
		let held = false;
		chatStore.appendTurnUsage = async (id: string, entry) => {
			if (!held) {
				held = true;
				await settleGate;
			}
			return originalAppendUsage.call(chatStore, id, entry);
		};
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "job-settle" });
		const result: ResearchResult = { brief: "settled result", sources: [] };
		jobStore.updateJob(job.id, { result, activity: "delivering result" });
		const steer = buildSubagentSteer(job, result);
		const runtime = await openChatRuntime(chat.id);
		try {
			await handleChatRequest(post(chat.id, { type: "text", text: "hello" }), { engine });
			await waitFor(() => held, 8000, "the settle service is held open");
			assert.equal(await isTurnRunning(chat.id), true, "the claim is still held");
			assert.equal(
				await steerLiveChat(chat.id, { id: "steer-settle", role: "user", content: "hold on", timestamp: 1 } as never),
				false,
				"a steer is refused while the run is already gone",
			);
			const delivered = deliverJobResult(chat.id, steer);
			const entriesAtHold = (await readEntries(runtime)).length;
			await new Promise((resolve) => setTimeout(resolve, 900));
			assert.equal(requests, 1, "no unmanaged model request from the steer or job result");
			assert.equal((await readEntries(runtime)).length, entriesAtHold, "no unmanaged native input committed");
			assert.equal(jobStore.getJob(job.id)!.status, "running", "the result waits for the claim");

			releaseSettle();
			await delivered;
			await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the settle releases");
			assert.equal(wake, 1, "the pump took the managed idle wake, not a native steer");
			assert.equal(jobStore.getJob(job.id)!.status, "done", "delivery settled");
			const settled = (await chatStore.getChat(chat.id))!;
			assert.equal(settled.turns?.length ?? 0, 1, "only the managed turn billed usage");

			// The client's 409 fallback: a plain send, one managed turn with usage.
			await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the settle claim is released");
			const fallbackAck = await handleChatRequest(post(chat.id, { type: "text", text: "hold on" }), { engine });
			assert.equal(fallbackAck.status, 200, `the fallback is accepted: ${await fallbackAck.clone().text()}`);
			await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the fallback turn settles");
			assert.equal(requests, 2, "the fallback is a real turn");
			assert.equal((await chatStore.getChat(chat.id))!.turns?.length ?? 0, 2, "the fallback is billed");
		} finally {
			chatStore.appendTurnUsage = originalAppendUsage;
		}
	});

	it("a steer placed at the native final boundary stays inside the managed turn", async () => {
		const chat = await createChat("Durable: final boundary steer");
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
		let releaseSecond!: () => void;
		const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
		let firstStarted = false;
		let secondStarted = false;
		let requests = 0;
		const faux = createFauxCore({});
		faux.setResponses([
			(async () => {
				firstStarted = true;
				await firstGate;
				return fauxAssistantMessage([fauxText("first reply")]);
			}) as FauxResponseStep,
			(async () => {
				secondStarted = true;
				await secondGate;
				return fauxAssistantMessage([fauxText("reply to the steer")]);
			}) as FauxResponseStep,
		]);
		const engine: PiEngine = {
			model: faux.getModel(),
			streamFn: (model, context, options) => {
				requests++;
				return faux.streamSimple(model, context, options);
			},
		};
		await handleChatRequest(post(chat.id, { type: "text", text: "start" }), { engine });
		const handle = runningTurn(chat.id);
		assert.ok(handle, "the turn is registered");
		const runtime = await openChatRuntime(chat.id);
		try {
			await waitFor(() => firstStarted, 8000, "the first provider request starts");
			const firstView = await runtime.root.viewState(BACKGROUND_CONTEXT);
			const firstRun = (firstView.value.docs["pi.live"] as LiveState | undefined)?.run?.taskId;
			firstView.dispose();
			assert.ok(firstRun, "the first native run is live");
			assert.equal(
				await steerLiveChat(
					chat.id,
					{ id: "steer-final", role: "user", content: "also explain", timestamp: 1 } as never,
				),
				true,
				"the steer is admitted to the live run",
			);
			releaseFirst();
			await waitFor(() => secondStarted, 8000, "the final boundary started the follow-up run");
			const secondView = await runtime.root.viewState(BACKGROUND_CONTEXT);
			const secondRun = (secondView.value.docs["pi.live"] as LiveState | undefined)?.run?.taskId;
			secondView.dispose();
			assert.ok(secondRun, "the follow-up native run is live");
			assert.notEqual(secondRun, firstRun, "the final boundary started a NEW native run");
			assert.equal(runningTurn(chat.id), handle, "one handle still claims the turn");
			assert.equal(await isTurnRunning(chat.id), true, "the claim is held through the follow-up");
			releaseSecond();
			await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the managed turn settles");
			assert.equal(runningTurn(chat.id), undefined, "the handle unregisters once");
			const wire = await new Response(handle.subscribe()).text();
			assert.equal(wire.match(/"type":"agent_end"/g)?.length ?? 0, 1, "one agent_end");
			assert.equal(requests, 2, "both responses used the bound engine");
			const settled = (await chatStore.getChat(chat.id))!;
			assert.equal(settled.turns?.length ?? 0, 1, "one TurnUsage");
			assert.equal(settled.turns![0]!.steps.length, 2, "both assistant entries billed to the turn");
			assert.ok(
				settled.messages.some((message) => JSON.stringify(message.content).includes("also explain")),
				"the steer is in the record",
			);
		} finally {
			releaseFirst();
			releaseSecond();
		}
	});

	it("a failed settle claim still releases the turn", async () => {
		const chat = await createChat("Durable: settle claim failure");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const faux = createFauxCore({});
		faux.setResponses([
			(async () => {
				await gate;
				return fauxAssistantMessage([fauxText("gated reply")]);
			}) as FauxResponseStep,
		]);
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const runtime = await openChatRuntime(chat.id);
		const commit = runtime.root.commit.bind(runtime.root);
		let failedOnce = false;
		await handleChatRequest(post(chat.id, { type: "text", text: "hello" }), { engine });
		runtime.root.commit = (async (change: never, context: never) => {
			if (!failedOnce) {
				failedOnce = true;
				throw new Error("storage write failed");
			}
			return commit(change, context);
		}) as typeof runtime.root.commit;
		try {
			release();
			await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the failed claim releases");
			assert.equal(runningTurn(chat.id), undefined, "no handle survives");
			const next = scripted([fauxAssistantMessage([fauxText("after recovery")])]);
			const ack = await handleChatRequest(post(chat.id, { type: "text", text: "again" }), { engine: next.engine });
			assert.equal(ack.status, 200, "the chat is not wedged");
			await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the next turn settles");
		} finally {
			runtime.root.commit = commit as typeof runtime.root.commit;
		}
	});

	it("a delete racing a metadata mutation never resurrects the record", async () => {
		const chat = await createChat("Durable: delete race");
		const changed = chatStore.saveSettings(chat.id, {
			model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
		});
		const deleted = chatStore.deleteChat(chat.id);
		const [mutation] = await Promise.allSettled([changed, deleted]);
		assert.ok(mutation.status === "fulfilled" || mutation.status === "rejected", "the mutation settles either way");
		assert.equal(fs.existsSync(path.join(PATHS.chats, `${chat.id}.json`)), false, "no metadata file survives");
		assert.equal(fs.existsSync(durableDir(chat.id)), false, "no runtime directory survives");
		assert.equal(await chatStore.getChat(chat.id), null, "the chat is gone");
	});
});
