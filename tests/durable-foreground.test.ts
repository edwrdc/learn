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
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn, settledTurnResponse, abortTurn } from "../src/server/turn-runs.ts";
import { isTurnRunning } from "../src/server/turn-liveness.ts";
import { appendRunUsage } from "../src/server/turn-service.ts";
import { deliverJobResult, setTurnRunner } from "../src/server/jobs.ts";
import { buildProbeHandoffSteer } from "../src/core/contracts.ts";
import { chatStore } from "../src/store/chats.ts";
import { appendMessages, closeChatRuntime, durableDir, readEntries } from "../src/store/durable.ts";
import { danglingQuestionOf, type LhMessage } from "../src/core/native-messages.ts";
import { buildAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";
import { projectView } from "../src/core/view.ts";
import { bareQuestionTools } from "../src/agent/teacher-agent.ts";
import { providerEventsDir } from "../src/agent/provider-events.ts";
import { PATHS } from "../config.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { AppTool } from "../src/agent/tool-adapter.ts";

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
	const wrap = (step: Step) => (context: { messages: unknown[] }) => {
		calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
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
			label: "slow",
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
		const entries = await readEntries(await import("../src/store/durable.ts").then((m) => m.openChatRuntime(chat.id)));
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
		const { engine, calls } = scripted([fauxAssistantMessage([fauxText("ok")])]);
		await turn(chat.id, { type: "text", text: "continue" }, engine);
		const prompt = calls[0]!.join("\n");
		assert.ok(prompt.includes("SUMMARY-TEXT"), "the active summary renders once at the head");
		assert.equal(prompt.split("SUMMARY-TEXT").length - 1, 1, "the marker never renders twice");
		assert.ok(prompt.includes("KEEP-ME"), "the kept tail rides the request");
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
		const delivery = deliverJobResult(buildProbeHandoffSteer(chat.id));
		await new Promise((r) => setTimeout(r, 900));
		assert.equal(wakes, 0, "the handoff waits while the run is live (it must START the teacher's run)");
		release();
		await waitFor(() => wakes > 0, 8000, "the handoff wake after settle");
		await delivery.catch(() => undefined);
		assert.equal(wakes, 1, "exactly one wake carries the handoff");
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

// keep the imported type referenced (records the LhMessage shape used above)
export type { LhMessage };
