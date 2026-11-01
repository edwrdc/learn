import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import type { Message, ToolCall, ToolResultMessage, TranscriptContext, UserMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxToolCall, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import {
	GenerationTask,
	Harness,
	MemoryStorage,
	createRegistry,
	defineExtension,
	defineTool,
	hook,
	type AgentChange,
	type Conversation,
	type ConversationId,
	type EntryRecord,
	type Extension,
	type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const ctx = BACKGROUND_CONTEXT;
const QUESTION_TOOLS = new Set(["quiz", "ask"]);
const BOOKKEEPING = "[[answer-bookkeeping]]";

const question = (name: string) =>
	defineTool({
		name,
		description: `${name} poses a question`,
		parameters: Type.Object({ question: Type.String(), bad: Type.Optional(Type.Boolean()) }),
		executionMode: "sequential",
		execute: async (args) =>
			args.bad
				? { isError: true, output: [{ type: "text" as const, text: "Invalid tool input: correctAnswer is required" }] }
				: { output: [{ type: "text" as const, text: "Question posed" }], control: { terminate: true } },
	});
const quiz = question("quiz");
const ask = question("ask");
const read = defineTool({
	name: "read",
	description: "Read a file",
	parameters: Type.Object({ path: Type.String() }),
	execute: async (args) => ({ output: [{ type: "text" as const, text: `contents of ${args.path}` }] }),
});
const problem = defineTool({
	name: "problem",
	description: "Pose a practice problem",
	parameters: Type.Object({ problem: Type.String() }),
	execute: async () => ({ output: [{ type: "text" as const, text: "Problem posed" }], control: { terminate: true } }),
});
const unlock = defineTool({
	name: "unlock",
	description: "Load the read tool",
	parameters: Type.Object({}),
	execute: async () => ({ output: [{ type: "text" as const, text: "read loaded" }], control: { addTools: ["read"] } }),
});
const handoff = defineTool({
	name: "handoff",
	description: "Hand off the conversation",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (args) => ({ output: [{ type: "text" as const, text: "handed off" }], control: { handoff: args.text } }),
});
const TOOLS = [quiz, ask, read, problem, unlock, handoff];

function questionStopHook(park = false) {
	return hook(GenerationTask, {
		afterTools: async (assistant, results, api, context) => {
			const message = (await api.entry(assistant, context))?.model?.[0];
			const calls = message?.role === "assistant" ? message.content : [];
			const questionIds = new Set(
				calls.flatMap((content) => (content.type === "toolCall" && QUESTION_TOOLS.has(content.name) ? [content.id] : [])),
			);
			if (questionIds.size === 0) return;
			for (const id of results) {
				const result = (await api.entry(id, context))?.model?.[0];
				if (result?.role === "toolResult" && questionIds.has(result.toolCallId) && result.isError) return;
			}
			return park ? ({ terminate: true, parkInputs: true } as const) : ({ terminate: true } as const);
		},
	});
}

/** A question whose tool call blocks until the test releases it, so a steer
 *  can be admitted while the run is provably live. */
function blockingQuestion() {
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tool = defineTool({
		name: "quiz",
		description: "pose question",
		parameters: Type.Object({ question: Type.String() }),
		execute: async () => {
			enter();
			await blocked;
			return { output: [{ type: "text" as const, text: "Question posed" }], control: { terminate: true as const } };
		},
	});
	return { tool, entered, release };
}

function bookkeepingDropHook() {
	return hook(GenerationTask, {
		beforeRequest: ({ messages }) => ({
			messages: messages.filter((message) => !(message.role === "user" && message.content === BOOKKEEPING)),
		}),
	});
}

type Opened = {
	harness: Harness;
	conversation: Conversation;
	requests: Message[][];
};

type OpenOptions = {
	hooks?: Extension["hooks"];
	tools?: readonly unknown[];
	storage?: Storage;
	agent?: AgentChange;
	conversationId?: ConversationId;
};

async function open(responses: FauxResponseStep[], options: OpenOptions = {}): Promise<Opened> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(
		defineExtension({ name: "question-stop-test", tools: (options.tools ?? TOOLS) as never, hooks: options.hooks ?? [questionStopHook()] }),
	);
	const harness = await Harness.open(
		options.storage ?? new MemoryStorage(),
		{ models, registry, settings: { retry: { enabled: false }, progress: { partialIntervalMs: 1, outputIntervalMs: 1 } } },
		ctx,
	);
	const model = faux.getModel();
	const conversation = options.conversationId
		? await harness.conversation(options.conversationId, ctx)
		: await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { model: { provider: model.provider, modelId: model.id }, ...options.agent },
				},
				ctx,
			);
	assert.ok(conversation);
	const requests: Message[][] = [];
	const record = (response: FauxResponseStep) => (context: TranscriptContext) => {
		requests.push([...context.messages]);
		return typeof response === "function" ? response(context, undefined, faux.state, model) : response;
	};
	faux.setResponses([
		...responses.map(record),
		(context) => {
			requests.push([...context.messages]);
			return fauxAssistantMessage("(stray request)");
		},
	]);
	return { harness, conversation, requests };
}

type Call = [name: string, args: ToolCall["arguments"], id: string];
const round = (calls: readonly Call[]) =>
	fauxAssistantMessage(calls.map(([name, args, id]) => fauxToolCall(name, args, { id })), { stopReason: "toolUse" });

async function run(opened: Opened, input = "go") {
	const settled = await (await opened.conversation.submit({ type: "input", content: input }, ctx)).wait(ctx);
	await opened.conversation.waitForIdle(ctx);
	const entries = (await opened.conversation.entries({ order: "ascending" }, 200, undefined, ctx)).items;
	return { settled, entries };
}

function toolResults(entries: readonly EntryRecord[]) {
	return entries.flatMap((entry) => {
		const message = entry.model?.[0];
		return message?.role === "toolResult" ? [{ call: message.toolCallId, isError: message.isError }] : [];
	});
}

function resultFor(entries: readonly EntryRecord[], call: string) {
	const result = toolResults(entries).find((entry) => entry.call === call);
	assert.ok(result, `missing tool result for ${call}`);
	return result;
}

/** The app's hidden continuation input (the reaction run's bookkeeping
 *  entry; the request hook drops it). Submitting it while the inbox holds a
 *  parked steer queues it behind the steer and one final boundary places
 *  both into the same run. */
async function continueRun(opened: Opened) {
	return (await opened.conversation.submit({ type: "input", content: BOOKKEEPING }, ctx)).wait(ctx);
}

describe("durable question stop gate", { concurrency: false }, () => {
	it("ends a clean question alone after one request", async () => {
		const opened = await open([round([["quiz", { question: "q1" }, "q1"]])]);
		try {
			const { settled, entries } = await run(opened);
			assert.equal(settled.status, "done");
			assert.equal(opened.requests.length, 1);
			assert.deepEqual(toolResults(entries), [{ call: "q1", isError: false }]);
		} finally {
			await opened.harness.close(ctx);
		}
	});

	const orders: { label: string; calls: Call[] }[] = [
		{ label: "question first", calls: [["quiz", { question: "q1" }, "q1"], ["read", { path: "a" }, "r1"]] },
		{ label: "sibling first", calls: [["read", { path: "a" }, "r1"], ["quiz", { question: "q1" }, "q1"]] },
	];
	for (const { label, calls } of orders) {
		it(`ends a clean question with a clean sibling, ${label}`, async () => {
			const opened = await open([round(calls), fauxAssistantMessage("after")]);
			try {
				const { settled, entries } = await run(opened);
				assert.equal(settled.status, "done");
				assert.equal(opened.requests.length, 1);
				assert.equal(resultFor(entries, "q1").isError, false);
				assert.equal(resultFor(entries, "r1").isError, false);
			} finally {
				await opened.harness.close(ctx);
			}
		});
	}

	it("ends a clean question with an unoffered sibling, keeping the sibling's error", async () => {
		const opened = await open([round([["quiz", { question: "q1" }, "q1"], ["nope", {}, "x1"]]), fauxAssistantMessage("after")]);
		try {
			const { settled, entries } = await run(opened);
			assert.equal(settled.status, "done");
			assert.equal(opened.requests.length, 1);
			assert.equal(resultFor(entries, "q1").isError, false);
			assert.equal(resultFor(entries, "x1").isError, true);
		} finally {
			await opened.harness.close(ctx);
		}
	});

	it("ends a clean question with a schema-invalid sibling, keeping the sibling's error", async () => {
		const opened = await open([round([["quiz", { question: "q1" }, "q1"], ["read", {}, "r1"]]), fauxAssistantMessage("after")]);
		try {
			const { settled, entries } = await run(opened);
			assert.equal(settled.status, "done");
			assert.equal(opened.requests.length, 1);
			assert.equal(resultFor(entries, "q1").isError, false);
			assert.equal(resultFor(entries, "r1").isError, true);
		} finally {
			await opened.harness.close(ctx);
		}
	});

	it("keeps the run going after an invalid question so the model can retry", async () => {
		const opened = await open([
			round([["quiz", { question: "q1", bad: true }, "q1"]]),
			round([["quiz", { question: "q1 retry" }, "q2"]]),
		]);
		try {
			const { settled, entries } = await run(opened);
			assert.equal(settled.status, "done");
			assert.equal(opened.requests.length, 2);
			assert.equal(resultFor(entries, "q1").isError, true);
			assert.equal(resultFor(entries, "q2").isError, false);
		} finally {
			await opened.harness.close(ctx);
		}
	});

	it("keeps the run going when one of two questions is invalid", async () => {
		const opened = await open([
			round([["quiz", { question: "q1" }, "q1"], ["ask", { question: "q2", bad: true }, "q2"]]),
			fauxAssistantMessage("after"),
		]);
		try {
			const { settled, entries } = await run(opened);
			assert.equal(settled.status, "done");
			assert.equal(opened.requests.length, 2);
			assert.equal(resultFor(entries, "q1").isError, false);
			assert.equal(resultFor(entries, "q2").isError, true);
		} finally {
			await opened.harness.close(ctx);
		}
	});

	for (const [label, hooks] of [
		["with the question hook", [questionStopHook()]],
		["with a hook returning nothing", [hook(GenerationTask, { afterTools: async () => {} })]],
		["without hooks", []],
	] as const) {
		it(`keeps native termination for a practice problem ${label}`, async () => {
			const opened = await open([round([["problem", { problem: "p1" }, "p1"]])], { hooks });
			try {
				const { settled, entries } = await run(opened);
				assert.equal(settled.status, "done");
				assert.equal(opened.requests.length, 1);
				assert.equal(resultFor(entries, "p1").isError, false);
			} finally {
				await opened.harness.close(ctx);
			}
		});
	}

	it("leaves a mixed round running when the hook returns nothing", async () => {
		const opened = await open([round([["quiz", { question: "q1" }, "q1"], ["read", { path: "a" }, "r1"]]), fauxAssistantMessage("after")], {
			hooks: [hook(GenerationTask, { afterTools: () => {} })],
		});
		try {
			const { settled } = await run(opened);
			assert.equal(settled.status, "done");
			assert.equal(opened.requests.length, 2);
		} finally {
			await opened.harness.close(ctx);
		}
	});

	it("still applies addTools when the extension stop ends the round", async () => {
		const opened = await open([round([["quiz", { question: "q1" }, "q1"], ["unlock", {}, "u1"]])], {
			agent: { modelTools: { remove: [read] } },
		});
		try {
			const { settled } = await run(opened);
			assert.equal(settled.status, "done");
			assert.equal(opened.requests.length, 1);
			const agent = await opened.conversation.agent(ctx);
			assert.ok(agent.tools.some((tool) => tool.name === "read"));
		} finally {
			await opened.harness.close(ctx);
		}
	});

	it("still applies handoff when the extension stop ends the round", async () => {
		const opened = await open([round([["quiz", { question: "q1" }, "q1"], ["handoff", { text: "take over" }, "h1"]])]);
		try {
			const { settled, entries } = await run(opened);
			assert.equal(settled.status, "done");
			assert.equal(opened.requests.length, 1);
			const reset = entries.find((entry) => entry.kind === "pi.reset");
			assert.ok(reset);
			const message = reset.model?.[0];
			assert.equal(message?.role, "user");
			assert.equal((message as UserMessage).content, "take over");
		} finally {
			await opened.harness.close(ctx);
		}
	});

	it("reopens a persisted question pause and answers it as the question's tool result", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lh-durable-stop-"));
		try {
			const file = join(dir, "chat.sqlite");
			const hooks = [questionStopHook(), bookkeepingDropHook()];
			const first = await open([round([["quiz", { question: "capital of France?" }, "q1"]])], {
				storage: await openNodeSqliteStorage(file),
				hooks,
			});
			await run(first, "pose");
			const entries = (await first.conversation.entries({ order: "ascending" }, 200, undefined, ctx)).items;
			const placeholder = entries.find((entry) => entry.model?.[0]?.role === "toolResult");
			assert.ok(placeholder);
			await first.harness.close(ctx);

			const second = await open([fauxAssistantMessage("Nice work.")], {
				storage: await openNodeSqliteStorage(file),
				hooks,
				conversationId: first.conversation.id,
			});
			const answer: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "q1",
				toolName: "quiz",
				content: [{ type: "text", text: "Paris" }],
				isError: false,
				timestamp: Date.now(),
			};
			await (
				await second.conversation.submit(
					{
						type: "write",
						entry: {
							kind: "lh.answer",
							data: { call: "q1" },
							edits: [{ target: placeholder.id, action: "replace", messages: [answer] }],
						},
					},
					ctx,
				)
			).wait(ctx);
			const settled = await (await second.conversation.submit({ type: "input", content: BOOKKEEPING }, ctx)).wait(ctx);
			await second.conversation.waitForIdle(ctx);
			assert.equal(settled.status, "done");
			assert.equal(second.requests.length, 1);
			const request = second.requests[0]!;
			assert.ok(
				request.some(
					(message) =>
						message.role === "toolResult" &&
						message.toolCallId === "q1" &&
						message.content.some((content) => content.type === "text" && content.text === "Paris"),
				),
			);
			assert.ok(!request.some((message) => message.role === "user" && message.content === BOOKKEEPING));
			const final = (await second.conversation.entries({ order: "ascending" }, 200, undefined, ctx)).items;
			assert.ok(
				final.some((entry) => {
					const message = entry.model?.[0];
					return (
						message?.role === "assistant" &&
						message.content.some((content) => content.type === "text" && content.text === "Nice work.")
					);
				}),
			);
			await second.harness.close(ctx);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("parks a steer queued behind a question and places it once when the answer starts the next run", async () => {
		const blocked = blockingQuestion();
		const opened = await open([round([["quiz", { question: "q1" }, "q1"]]), fauxAssistantMessage("Answered.")], {
			tools: [blocked.tool],
			hooks: [questionStopHook(true), bookkeepingDropHook()],
		});
		try {
			const first = await opened.conversation.submit({ type: "input", content: "ask me" }, ctx);
			await blocked.entered;
			const steer = await opened.conversation.submit(
				{ type: "input", content: "a job finished", whenBusy: "steer" },
				ctx,
			);
			blocked.release();
			await first.wait(ctx);
			await opened.conversation.waitForIdle(ctx);
			assert.equal(opened.requests.length, 1, "no model call while the question waits for the learner");
			assert.equal((await steer.status(ctx)).status, "queued", "the steer is parked, not placed or withdrawn");

			const settled = await continueRun(opened);
			assert.equal(settled.status, "done");
			assert.equal(opened.requests.length, 2, "the continuation starts exactly one reaction run");
			const reaction = opened.requests[1]!;
			assert.ok(reaction.some((message) => message.role === "user" && message.content === "a job finished"));
			assert.ok(!reaction.some((message) => message.role === "user" && message.content === BOOKKEEPING));
			assert.equal((await steer.status(ctx)).status, "done", "the reaction run answered the placed steer");
			const entries = (await opened.conversation.entries({ order: "ascending" }, 200, undefined, ctx)).items;
			assert.equal(
				entries.filter((entry) => entry.model?.[0]?.role === "user" && entry.model[0].content === "a job finished")
					.length,
				1,
				"placed exactly once",
			);
		} finally {
			await opened.harness.close(ctx);
		}
	});

	it("keeps a parked steer across a reopen and places it once on the answer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lh-durable-park-"));
		try {
			const file = join(dir, "chat.sqlite");
			const blocked = blockingQuestion();
			const first = await open([round([["quiz", { question: "q1" }, "q1"]])], {
				storage: await openNodeSqliteStorage(file),
				tools: [blocked.tool],
				hooks: [questionStopHook(true), bookkeepingDropHook()],
			});
			const pose = await first.conversation.submit({ type: "input", content: "ask me" }, ctx);
			await blocked.entered;
			const steer = await first.conversation.submit(
				{ type: "input", content: "a job finished", whenBusy: "steer" },
				ctx,
			);
			blocked.release();
			await pose.wait(ctx);
			await first.conversation.waitForIdle(ctx);
			assert.equal(first.requests.length, 1);
			await first.harness.close(ctx);

			const second = await open([fauxAssistantMessage("Answered.")], {
				storage: await openNodeSqliteStorage(file),
				tools: [blocked.tool],
				hooks: [questionStopHook(true), bookkeepingDropHook()],
				conversationId: first.conversation.id,
			});
			assert.equal(second.requests.length, 0, "reopening runs nothing");
			const settled = await continueRun(second);
			assert.equal(settled.status, "done");
			assert.equal(second.requests.length, 1, "one reaction run after the continuation");
			assert.ok(
				second.requests[0]!.some((message) => message.role === "user" && message.content === "a job finished"),
			);
			const entries = (await second.conversation.entries({ order: "ascending" }, 200, undefined, ctx)).items;
			assert.equal(
				entries.filter((entry) => entry.model?.[0]?.role === "user" && entry.model[0].content === "a job finished")
					.length,
				1,
				"placed exactly once after the reopen",
			);
			const handle = await second.harness.submission(steer.id, ctx);
			assert.equal((await handle!.status(ctx)).status, "done", "placed and answered after the reopen");
			await second.harness.close(ctx);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps native handoff placement when the round also asks to park", async () => {
		const blocked = blockingQuestion();
		const opened = await open(
			[
				round([
					["quiz", { question: "q1" }, "q1"],
					["handoff", { text: "take over" }, "h1"],
				]),
				fauxAssistantMessage("After the handoff."),
			],
			{ tools: [blocked.tool, handoff], hooks: [questionStopHook(true), bookkeepingDropHook()] },
		);
		try {
			const first = await opened.conversation.submit({ type: "input", content: "ask me" }, ctx);
			await blocked.entered;
			const steer = await opened.conversation.submit(
				{ type: "input", content: "a job finished", whenBusy: "steer" },
				ctx,
			);
			blocked.release();
			await first.wait(ctx);
			await opened.conversation.waitForIdle(ctx);
			const entries = (await opened.conversation.entries({ order: "ascending" }, 200, undefined, ctx)).items;
			assert.ok(entries.some((entry) => entry.kind === "pi.reset"), "the handoff reset still lands");
			assert.equal((await steer.status(ctx)).status, "done", "the handoff boundary still places queued input");
			assert.equal(opened.requests.length, 2, "the handoff starts its run with the queued steer");
		} finally {
			await opened.harness.close(ctx);
		}
	});

	it("keeps a queued reset native when the round also asks to park", async () => {
		const blocked = blockingQuestion();
		const opened = await open([round([["quiz", { question: "q1" }, "q1"]])], {
			tools: [blocked.tool],
			hooks: [questionStopHook(true), bookkeepingDropHook()],
		});
		try {
			const first = await opened.conversation.submit({ type: "input", content: "ask me" }, ctx);
			await blocked.entered;
			await opened.conversation.submit(
				{
					type: "write",
					entry: {
						kind: "lh.reset",
						head: "self",
						model: [{ role: "user", content: "restart", timestamp: Date.now() }],
					},
				},
				ctx,
			);
			blocked.release();
			await first.wait(ctx);
			await opened.conversation.waitForIdle(ctx);
			const entries = (await opened.conversation.entries({ order: "ascending" }, 200, undefined, ctx)).items;
			assert.ok(entries.some((entry) => entry.kind === "lh.reset"), "the queued reset still lands");
			assert.equal(opened.requests.length, 1);
		} finally {
			await opened.harness.close(ctx);
		}
	});

	it("the installed dependency carries the compatibility patch", () => {
		// `npm ci` runs scripts/patch-pi-durable.mjs through postinstall. A
		// fresh install without the patch must fail here, not only through
		// the behavioral regressions below.
		const installed = dirname(createRequire(import.meta.url).resolve("@earendil-works/pi-durable/package.json"));
		const runtime = readFileSync(join(installed, "dist/harness/generation.js"), "utf8");
		assert.match(runtime, /extensionTerminate/, "the afterTools stop is missing");
		assert.match(runtime, /extensionPark/, "the question input park is missing");
		assert.match(runtime, /hasQueuedReset\(boundary\.inbox\.items\)/, "the park/native-reset guard is missing");
		const types = readFileSync(join(installed, "dist/harness/types.d.ts"), "utf8");
		assert.match(types, /parkInputs/, "the hook result type is missing");
		assert.match(types, /entry\(id: EntryId/, "the hook entry read is missing");
	});

	it("keeps a patched install unchanged and refuses another version or source", () => {
		const installed = dirname(createRequire(import.meta.url).resolve("@earendil-works/pi-durable/package.json"));
		const script = fileURLToPath(new URL("../scripts/patch-pi-durable.mjs", import.meta.url));
		const dir = mkdtempSync(join(tmpdir(), "lh-durable-patch-"));
		try {
			const copy = join(dir, "pkg");
			cpSync(installed, copy, { recursive: true });
			for (const attempt of ["first", "second"]) {
				const result = spawnSync(process.execPath, [script, copy], { encoding: "utf8" });
				assert.equal(result.status, 0, `${attempt} run: ${result.stderr}`);
				assert.match(result.stdout, /already patched/);
			}

			const manifestPath = join(copy, "package.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "1.4.1" }));
			const versionMismatch = spawnSync(process.execPath, [script, copy], { encoding: "utf8" });
			assert.equal(versionMismatch.status, 1);
			assert.match(versionMismatch.stderr, /targets @earendil-works\/pi-durable@1\.4\.0/);

			writeFileSync(manifestPath, JSON.stringify(manifest));
			const runtime = join(copy, "dist/harness/generation.js");
			writeFileSync(runtime, readFileSync(runtime, "utf8").replace("extensionTerminate", "corrupted"));
			const sourceMismatch = spawnSync(process.execPath, [script, copy], { encoding: "utf8" });
			assert.equal(sourceMismatch.status, 1);
			assert.match(sourceMismatch.stderr, /is not the expected @earendil-works\/pi-durable@1\.4\.0 source/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
