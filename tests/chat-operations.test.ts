import { processState } from "../src/platform/model/index.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { PiEngine } from "../src/platform/engines.ts";
import type { FauxResponseStep } from "@earendil-works/pi-ai";

const originalEnv = { LH_DATA_DIR: process.env.LH_DATA_DIR, NODE_ENV: process.env.NODE_ENV, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-operations-"));
process.env.LH_DATA_DIR = TMP;
process.env.NODE_ENV = "production";
process.env.OPENROUTER_API_KEY = "test-key-presence-gate";

const { PATHS } = await import("../src/platform/config.ts");
assert.equal(PATHS.data, TMP);
const { createFauxCore, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
const { Harness, ConversationBusy } = await import("@earendil-works/pi-durable");
const { withChatOperation } = await import("../src/session/chat-operations.ts");
const { chatStore } = await import("../src/session/store.ts");
const { stores } = await import("../src/stores.ts");
const { handleChatInput, foregroundEngineOverride } = await import("../src/session/turn.ts");
await (await import("../src/boot.ts")).boot().recovered;
const { deleteChatSession } = await import("../src/session/operations.ts");
const { openChatRuntime, closeChatRuntime, peekChatRuntime, appendMessages, readEntries, ChatRuntimeInitError } = await import("../src/session/durable.ts");
const { beginTurn, endTurn, isTurnRunning } = await import("../src/session/turn-liveness.ts");
const { runningTurn, unregisterTurn } = await import("../src/session/turn-runs.ts");
const { ensureCompacted } = await import("../src/session/compaction.ts");
const { newUserMessage } = await import("../src/session/model/transcript.ts");
const { subscribe } = await import("../src/platform/model/events.ts");
const { readTurn } = await import("../src/session/turn-service.ts");
const created: string[] = [];
const oldOverride = foregroundEngineOverride.current;

after(async () => {
	stores.chatStore = chatStore;
	foregroundEngineOverride.current = oldOverride;
	for (const id of created) {
		await closeChatRuntime(id);
		endTurn(id);
		unregisterTurn(id);
	}
	fs.rmSync(TMP, { recursive: true, force: true });
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function gatedEngine() {
	const entered = deferred();
	const release = deferred();
	let calls = 0;
	const faux = createFauxCore({});
	faux.setResponses([(async (_context: unknown, options?: { signal?: AbortSignal }) => {
		calls++;
		entered.resolve();
		const signal = options?.signal;
		const abort = () => release.resolve();
		if (signal?.aborted) abort();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			await release.promise;
			return fauxAssistantMessage("done");
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}) as FauxResponseStep] as never);
	return {
		engine: { model: faux.getModel(), streamFn: faux.streamSimple } satisfies PiEngine,
		entered: entered.promise,
		release: release.resolve,
		get calls() { return calls; },
	};
}

async function createChat(title: string) {
	const chat = chatStore.createChat(title);
	created.push(chat.id);
	await chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return chat;
}

async function finish(chatId: string, model: ReturnType<typeof gatedEngine>) {
	const handle = runningTurn(chatId);
	const wire = handle ? new Response(handle.subscribe()).text() : Promise.resolve("");
	model.release();
	await wire;
	assert.equal(await isTurnRunning(chatId), false);
	assert.equal(runningTurn(chatId), undefined);
}

describe("per-chat operation queue", { concurrency: false, timeout: 15_000 }, () => {
	it("shares FIFO ordering across module copies, keeps other chats independent, and removes only its own tail", async () => {
		const copy = await import("../src/session/chat-operations.ts?copy=" + Date.now());
		assert.notEqual(copy.withChatOperation, withChatOperation);
		const firstEntered = deferred();
		const firstRelease = deferred();
		const secondEntered = deferred();
		const secondRelease = deferred();
		const order: number[] = [];
		const first = withChatOperation("queue-a", async () => {
			order.push(1);
			firstEntered.resolve();
			await firstRelease.promise;
			return "first";
		});
		await firstEntered.promise;
		const second = copy.withChatOperation("queue-a", async () => {
			order.push(2);
			secondEntered.resolve();
			await secondRelease.promise;
			return "second";
		});
		try {
			assert.equal(await withChatOperation("queue-b", async () => 42), 42);
			assert.deepEqual(order, [1]);
			firstRelease.resolve();
			assert.equal(await first, "first");
			await secondEntered.promise;
			const third = withChatOperation("queue-a", async () => { order.push(3); return "third"; });
			await withChatOperation("queue-b", async () => undefined);
			assert.deepEqual(order, [1, 2]);
			secondRelease.resolve();
			assert.deepEqual(await Promise.all([second, third]), ["second", "third"]);
			assert.deepEqual(order, [1, 2, 3]);
			assert.equal(processState<Map<string, unknown>>("lock.chatOperation", () => new Map()).has("queue-a"), false);
		} finally {
			firstRelease.resolve();
			secondRelease.resolve();
			await Promise.allSettled([first, second]);
		}
	});

	it("preserves rejected results and advances after asynchronous and synchronous failures", async () => {
		const failure = new Error("operation failed");
		for (const run of [async () => { throw failure; }, () => { throw failure; }]) {
			const rejected = assert.rejects(withChatOperation("queue-fail", run), (error) => error === failure);
			const next = withChatOperation("queue-fail", async () => "next");
			await rejected;
			assert.equal(await next, "next");
		}
	});

	it("queues both entrypoints before their first existence read", async () => {
		const release = deferred();
		const entered = deferred();
		let reads = 0;
		stores.chatStore = { ...chatStore, getChat: async () => { reads++; return null; } };
		const held = withChatOperation("missing-guard", async () => { entered.resolve(); await release.promise; });
		await entered.promise;
		const input = handleChatInput("missing-guard", { type: "text", text: "hello" });
		const deletion = deleteChatSession("missing-guard", "delete-nodes");
		try {
			await withChatOperation("checkpoint", async () => undefined);
			assert.equal(reads, 0);
			release.resolve();
			assert.equal((await input).status, 404);
			assert.deepEqual(await deletion, { ok: false, status: 404, code: "not_found", error: "No such session" });
			assert.equal(reads, 2);
		} finally {
			release.resolve();
			await Promise.allSettled([held, input, deletion]);
			stores.chatStore = chatStore;
		}
	});

	it("holds deletion behind admission through real gated compaction, but not through generation", async () => {
		const chat = await createChat("admission first");
		await appendMessages(chat.id, [newUserMessage("x".repeat(120_000)), newUserMessage("y".repeat(120_000)), newUserMessage("recent")]);
		const model = gatedEngine();
		const summaryEntered = deferred();
		const summaryRelease = deferred();
		const compact = ensureCompacted({
			chatStore, engine: model.engine, modelId: "faux:test", kind: "probe", thresholdTokens: 10_000, systemPromptTokens: 0,
			summarize: async () => {
				summaryEntered.resolve();
				await summaryRelease.promise;
				return { summary: "short history", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			},
		}, chat.id);
		await summaryEntered.promise;
		const firstRead = deferred();
		const readRelease = deferred();
		let reads = 0;
		stores.chatStore = {
			...chatStore,
			getChat: async (id) => {
				reads++;
				const record = await chatStore.getChat(id);
				if (reads === 1) { firstRead.resolve(); await readRelease.promise; }
				return record;
			},
		};
		const input = handleChatInput(chat.id, { type: "text", text: "new learner input" }, { engine: model.engine });
		await firstRead.promise;
		const deletion = deleteChatSession(chat.id, "delete-nodes");
		try {
			readRelease.resolve();
			await withChatOperation("checkpoint", async () => undefined);
			assert.equal(reads, 1, "DELETE cannot enter while compaction is held");
			assert.ok(fs.existsSync(path.join(TMP, "durable", chat.id)));
			summaryRelease.resolve();
			await compact;
			assert.equal((await input).status, 200);
			await model.entered;
			const outcome = await deletion;
			assert.equal(outcome.ok, false);
			assert.ok(!outcome.ok && outcome.code === "turn_in_flight");
			assert.equal(model.calls, 1);
			assert.equal(await isTurnRunning(chat.id), true);
			assert.equal((await handleChatInput(chat.id, { type: "text", text: "second input" }, { engine: model.engine })).status, 409);
			assert.equal((await handleChatInput(chat.id, { type: "answer", toolCallId: "missing", answer: {} as never }, { engine: model.engine })).status, 400);
			assert.equal(await isTurnRunning(chat.id), true, "rejected inputs must not release the live claim");
			stores.chatStore = chatStore;
			await finish(chat.id, model);
			const record = (await chatStore.getChat(chat.id))!;
			assert.equal(record.messages.filter((message) => message.role === "user" && message.content === "new learner input").length, 1);
			assert.equal((await deleteChatSession(chat.id, "delete-nodes")).ok, true);
		} finally {
			readRelease.resolve();
			summaryRelease.resolve();
			model.release();
			await Promise.allSettled([compact, input, deletion]);
			stores.chatStore = chatStore;
		}
	});

	it("keeps admission behind deletion through the actual awaited runtime close", async () => {
		const chat = await createChat("deletion first");
		const runtime = await openChatRuntime(chat.id);
		const realClose = runtime.harness.close;
		const closeEntered = deferred();
		const closeRelease = deferred();
		const model = gatedEngine();
		let reads = 0;
		stores.chatStore = { ...chatStore, getChat: (id) => { reads++; return chatStore.getChat(id); } };
		runtime.harness.close = async (...args) => { closeEntered.resolve(); await closeRelease.promise; return realClose.apply(runtime.harness, args); };
		const deletion = deleteChatSession(chat.id, "delete-nodes");
		await closeEntered.promise;
		const input = handleChatInput(chat.id, { type: "text", text: "too late" }, { engine: model.engine });
		try {
			await withChatOperation("checkpoint", async () => undefined);
			assert.equal(reads, 1, "the queued input must not read during close");
			closeRelease.resolve();
			assert.equal((await deletion).ok, true);
			assert.equal((await input).status, 404);
			assert.equal(model.calls, 0);
			assert.equal(peekChatRuntime(chat.id), undefined);
			assert.equal(fs.existsSync(path.join(TMP, "durable", chat.id)), false);
			assert.equal(fs.existsSync(path.join(TMP, "chats", chat.id + ".json")), false);
		} finally {
			closeRelease.resolve();
			model.release();
			await Promise.allSettled([deletion, input]);
			runtime.harness.close = realClose;
			stores.chatStore = chatStore;
		}
	});

	it("orders two deletions", async () => {
		const chat = await createChat("two deletes");
		let calls = 0;
		stores.chatStore = { ...chatStore, deleteChat: async (id) => { calls++; return chatStore.deleteChat(id); } };
		try {
			const [first, second] = await Promise.all([deleteChatSession(chat.id, "delete-nodes"), deleteChatSession(chat.id, "delete-nodes")]);
			assert.equal(first.ok, true);
			assert.ok(!second.ok && second.status === 404);
			assert.equal(calls, 1);
		} finally { stores.chatStore = chatStore; }
	});

	for (const failure of [new Error("EACCES: private filesystem path"), false]) {
		it(`reports deletion ${failure === false ? "false" : "failure"} without leaking details and releases the queue for retry`, async () => {
			try {
				const retry = await createChat("failed delete");
				stores.graphStore.appendCheckpoint({ chatId: retry.id, foldedAt: retry.updatedAt });
				const job = stores.jobStore.createJob({ kind: "research", chatId: retry.id, toolCallId: "failed-delete" });
				stores.jobStore.updateJob(job.id, { status: "done" });
				stores.chatStore = { ...chatStore, deleteChat: async () => {
					if (failure instanceof Error) throw failure;
					return false;
				} };
				assert.deepEqual(await deleteChatSession(retry.id, "delete-nodes"), {
					ok: false, status: 500, code: "delete_failed", error: "Session deletion failed. Try again.",
				});
				assert.equal(stores.graphStore.readCheckpoints().some((row) => row.chatId === retry.id), false);
				assert.equal(stores.jobStore.getJob(job.id), null);
				assert.ok(await chatStore.getChat(retry.id), "the failed deletion leaves the chat available for retry");
				stores.chatStore = chatStore;
				assert.equal((await deleteChatSession(retry.id, "delete-nodes")).ok, true);
				assert.deepEqual(await deleteChatSession(retry.id, "delete-nodes"), {
					ok: false, status: 404, code: "not_found", error: "No such session",
				});
			} finally { stores.chatStore = chatStore; }
		});
	}

	it("releases a claim when the previously uncovered post-claim entry read rejects", async () => {
		const chat = await createChat("post-claim read failure");
		const runtime = await openChatRuntime(chat.id);
		const realEntries = runtime.root.entries;
		const failure = new Error("entry read failed");
		const model = gatedEngine();
		let touched = false;
		stores.chatStore = { ...chatStore, touchChat: async (id) => { await chatStore.touchChat(id); touched = true; } };
		let starts = 0;
		const off = subscribe((event) => { if (event.type === "turn-started" && event.chatId === chat.id) starts++; });
		runtime.root.entries = async (...args) => {
			if (touched && await isTurnRunning(chat.id)) throw failure;
			return realEntries.apply(runtime.root, args);
		};
		try {
			await assert.rejects(handleChatInput(chat.id, { type: "text", text: "retry me" }, { engine: model.engine }), (error) => error === failure);
			assert.equal(await isTurnRunning(chat.id), false);
			assert.equal(runningTurn(chat.id), undefined);
			assert.equal(starts, 0);
			runtime.root.entries = realEntries;
			stores.chatStore = chatStore;
			assert.equal((await handleChatInput(chat.id, { type: "text", text: "retry me" }, { engine: model.engine })).status, 200);
			await finish(chat.id, model);
		} finally {
			runtime.root.entries = realEntries;
			stores.chatStore = chatStore;
			model.release();
			off();
		}
	});

	it("preserves submit failure responses and clears only the admission claim", async () => {
		const chat = await createChat("submit failures");
		const runtime = await openChatRuntime(chat.id);
		const realSubmit = runtime.root.submit;
		const model = gatedEngine();
		try {
			for (const failure of [new Error("pre-commit submit failed"), new ConversationBusy(runtime.root.id)]) {
				runtime.root.submit = async () => { throw failure; };
				const response = await handleChatInput(chat.id, { type: "text", text: "not committed" }, { engine: model.engine });
				assert.equal(response.status, failure instanceof ConversationBusy ? 409 : 500);
				assert.equal(await isTurnRunning(chat.id), false);
				assert.equal(runningTurn(chat.id), undefined);
			}
			runtime.root.submit = realSubmit;
			assert.equal((await handleChatInput(chat.id, { type: "text", text: "committed once" }, { engine: model.engine })).status, 200);
			await finish(chat.id, model);
		} finally {
			runtime.root.submit = realSubmit;
			model.release();
		}
	});

	it("keeps cheap sibling-answer writes inside the queue and lets concurrent last answers start exactly one turn", async () => {
		for (const answerLast of [false, true]) {
			const chat = await createChat("sibling answers");
			const question = { question: "Which topic?", options: [{ label: "History" }, { label: "Chemistry" }] };
			await appendMessages(chat.id, [{
				...fauxAssistantMessage([
					fauxToolCall("ask_user_question", question, { id: "q-first" }),
					fauxToolCall("ask_user_question", question, { id: "q-last" }),
				], { stopReason: "toolUse" }), id: "two-questions",
			}]);
			const runtime = await openChatRuntime(chat.id);
			const realCommit = runtime.harness.commit;
			const writeEntered = deferred();
			const writeRelease = deferred();
			const model = gatedEngine();
			let reads = 0;
			stores.chatStore = { ...chatStore, getChat: (id) => { reads++; return chatStore.getChat(id); } };
			runtime.harness.commit = async (change, context) => {
				writeEntered.resolve();
				await writeRelease.promise;
				return realCommit.bind(runtime.harness)(change, context);
			};
			const answer = { kind: "ask" as const, questionText: question.question, dontKnow: false, answers: [], text: "History", answeredAt: new Date().toISOString() };
			const first = handleChatInput(chat.id, { type: "answer", toolCallId: "q-first", answer }, { engine: model.engine });
			await writeEntered.promise;
			const readsAtWrite = reads;
			const last = answerLast ? handleChatInput(chat.id, { type: "answer", toolCallId: "q-last", answer }, { engine: model.engine }) : undefined;
			const deletion = deleteChatSession(chat.id, "delete-nodes");
			try {
				await withChatOperation("checkpoint", async () => undefined);
				assert.equal(reads, readsAtWrite, "neither DELETE nor a later answer can enter during the cheap answer write");
				runtime.harness.commit = realCommit;
				writeRelease.resolve();
				assert.equal((await first).status, 200);
				if (last) {
					assert.equal((await last).status, 200);
					await model.entered;
					const outcome = await deletion;
					assert.ok(!outcome.ok && outcome.code === "turn_in_flight");
					assert.equal(model.calls, 1);
					stores.chatStore = chatStore;
					await finish(chat.id, model);
					const record = (await chatStore.getChat(chat.id))!;
					assert.equal(record.messages.filter((message) => message.role === "toolResult" && ["q-first", "q-last"].includes(message.toolCallId)).length, 2);
				} else {
					assert.equal((await deletion).ok, true);
					assert.equal(model.calls, 0);
				}
			} finally {
				runtime.harness.commit = realCommit;
				writeRelease.resolve();
				model.release();
				await Promise.allSettled([first, last, deletion]);
				stores.chatStore = chatStore;
			}
		}
	});

	it("releases failed write-ahead claims and keeps rapid completions from releasing a later claim", async () => {
		const chat = await createChat("rapid completion");
		const runtime = await openChatRuntime(chat.id);
		const realEntries = runtime.root.entries;
		const model = gatedEngine();
		try {
			runtime.root.entries = async (...args) => {
				if (await isTurnRunning(chat.id)) throw new Error("write-ahead read failed");
				return realEntries.apply(runtime.root, args);
			};
			assert.equal((await handleChatInput(chat.id, { type: "text", text: "not committed" }, { engine: model.engine })).status, 500);
			assert.equal(await isTurnRunning(chat.id), false);
			runtime.root.entries = realEntries;
			const faux = createFauxCore({});
			faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")] as never);
			for (const text of ["first", "second"]) {
				const settled = deferred();
				const off = subscribe((event) => { if (event.type === "turn-settled" && event.chatId === chat.id) settled.resolve(); });
				try {
					assert.equal((await handleChatInput(chat.id, { type: "text", text }, { engine: { model: faux.getModel(), streamFn: faux.streamSimple } })).status, 200);
					await settled.promise;
				} finally { off(); }
			}
			assert.equal((await handleChatInput(chat.id, { type: "text", text: "held turn" }, { engine: model.engine })).status, 200);
			await model.entered;
			assert.equal((await handleChatInput(chat.id, { type: "text", text: "must refuse" }, { engine: model.engine })).status, 409);
			assert.equal(await isTurnRunning(chat.id), true);
			await finish(chat.id, model);
		} finally {
			runtime.root.entries = realEntries;
			model.release();
		}
	});

	it("fails recovery submission lookup without claiming, then recovers through guarded deletion and input", async () => {
		const chat = await createChat("recovery lookup");
		const first = gatedEngine();
		const resumed = gatedEngine();
		const realOpen = Harness.open;
		const failure = new Error("recovery lookup failed");
		let lookupFailed = false;
		try {
			assert.equal((await handleChatInput(chat.id, { type: "text", text: "recover this" }, { engine: first.engine })).status, 200);
			await first.entered;
			await closeChatRuntime(chat.id);
			endTurn(chat.id);
			unregisterTurn(chat.id);
			foregroundEngineOverride.current = resumed.engine;
			Harness.open = async (...args) => {
				const harness = await realOpen.apply(Harness, args);
				harness.submission = async () => { lookupFailed = true; throw failure; };
				return harness;
			};
			await assert.rejects(openChatRuntime(chat.id), ChatRuntimeInitError);
			assert.equal(lookupFailed, true);
			assert.equal(beginTurn(chat.id), true, "failed recovery must leave no new claim");
			endTurn(chat.id);
			assert.equal(runningTurn(chat.id), undefined);
			Harness.open = realOpen;
			const deletion = await deleteChatSession(chat.id, "delete-nodes");
			assert.ok(!deletion.ok && deletion.code === "turn_in_flight");
			await resumed.entered;
			assert.equal((await handleChatInput(chat.id, { type: "text", text: "must refuse" }, { engine: resumed.engine })).status, 409);
			assert.equal(await isTurnRunning(chat.id), true);
			await finish(chat.id, resumed);
			const runtime = await openChatRuntime(chat.id);
			assert.equal((await readTurn(runtime))?.settle, "settled");
			assert.equal((await readEntries(runtime)).filter((entry) => JSON.stringify(entry).includes("recover this")).length, 1);
			assert.equal(resumed.calls, 1);
		} finally {
			Harness.open = realOpen;
			foregroundEngineOverride.current = oldOverride;
			first.release();
			resumed.release();
		}
	});
});
