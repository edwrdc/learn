/**
 * Durable background restart predicate (unit C): a process death during a
 * background run must leave the child conversation, its role tools, its
 * prompt and its engine recoverable from committed state, and the re-entry
 * must finish the job WITHOUT re-submitting the input or spending the
 * completed work again.
 *
 * The "process death" here is a real Harness close mid-model-call, then a
 * fresh open: open runs the runtime bootstrap (reinstall the role extension,
 * prompt and Models binding from the run descriptor) BEFORE harness.resume().
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-durable-background-"));
process.env.LH_DATA_DIR = TMP;

const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const {
	ChatRuntimeInitError,
	closeChatRuntime,
	openChatRuntime,
} = await import("../src/store/durable.ts");
const { BackgroundRunsDoc, configureBackgroundRuns } = await import("../src/server/durable-background.ts");
type RunDescriptor = import("../src/server/durable-background.ts").RunDescriptor;
const { createJobRunner, researchModelOverride } = await import("../src/agent/subagents/runner.ts");
const { setTurnRunner } = await import("../src/server/jobs.ts");
// The composition root wires the background host services at module init.
await import("../src/server/chat-handler.ts");
type PiEngine = import("../src/agent/models.ts").PiEngine;
type SearchProvider = import("../src/core/search.ts").SearchProvider;
type SteerMessage = import("../src/core/contracts.ts").SteerMessage;
type ResearchResult = import("../src/core/contracts.ts").ResearchResult;

const BRIEF = `## Summary\nRestart-checked.\n\n## Sources\n- [docs](https://example.com/docs)`;
const PROMPT_INPUT = { question: "Does restart reattach?", context: "durable background test" };

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** A model call that never resolves until its abort signal fires. */
function hangUntilAborted(): FauxResponseStep {
	return ((_context: unknown, options: { signal?: AbortSignal } | undefined) =>
		new Promise<AssistantMessage>((resolve) => {
			const signal = options?.signal;
			const finish = () => resolve(fauxAssistantMessage("interrupted"));
			if (signal?.aborted) finish();
			else signal?.addEventListener("abort", finish, { once: true });
		})) as unknown as FauxResponseStep;
}

function stubSearch(): SearchProvider & { queries: string[] } {
	const queries: string[] = [];
	return {
		id: "tavily",
		async search(query: string) {
			queries.push(query);
			return [{ title: "docs", url: "https://example.com/docs", snippet: "restart" }];
		},
		queries,
	};
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10000, what = "condition"): Promise<void> {
	const started = Date.now();
	for (;;) {
		if (await cond()) return;
		if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("durable background restart", () => {
	it("reinstalls the role tools and engine from the descriptor, then finishes without a duplicate input", async () => {
		const chat = await chatStore.createChat("Durable: background restart");
		// The dispatch-time input lives in the transcript (the recovery scan path).
		await chatStore.saveMessages(chat.id, [
			{ id: "u1", role: "user", content: "research please", timestamp: 1 } as never,
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "call-restart", name: "research", arguments: PROMPT_INPUT as never }],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 1,
			} as never,
			{
				id: "r1",
				role: "toolResult",
				toolCallId: "call-restart",
				toolName: "research",
				content: [{ type: "text", text: "Dispatched." }],
				details: "Dispatched.",
				isError: false,
				timestamp: 1,
			} as never,
		]);
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-restart" });
		const search = stubSearch();
		const delivered: SteerMessage[] = [];
		setTurnRunner(async () => 200);
		const runner = createJobRunner({
			chatStore,
			jobStore,
			deliver: async (steer) => {
				delivered.push(steer);
			},
			searchProvider: () => search,
		});

		// Turn 1: a web_search call proves the tools run; turn 2 hangs in the
		// model call when the "process" dies.
		researchModelOverride.current = fauxEngine([
			fauxAssistantMessage([fauxToolCall("web_search", { query: "restart reattach" }, { id: "ws-restart" })], {
				stopReason: "toolUse",
			}),
			hangUntilAborted(),
			fauxAssistantMessage([fauxText(BRIEF)]),
		]);
		const first = runner.runJob(job.id, PROMPT_INPUT);
		await waitFor(() => (jobStore.getJob(job.id)!.usage?.steps ?? 0) >= 1, 10000, "first model call billed");
		assert.deepEqual(search.queries, ["restart reattach"], "the role tool set ran inside the durable conversation");


		// Process death mid-call: close the Harness (storage included).
		await closeChatRuntime(chat.id);
		await first.catch(() => undefined);

		// The recovered run's engine resolves from the persisted descriptor.
		// The resumed model asks for the role's tool BEFORE answering: the
		// bootstrap must have installed that tool set before resume, or the
		// call cannot run.
		const resumed = fauxEngine([
			fauxAssistantMessage([fauxToolCall("web_search", { query: "after restart" }, { id: "ws-restart-2" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText(BRIEF)]),
		]);
		configureBackgroundRuns({
			resolveEngine: (descriptor: RunDescriptor) =>
				descriptor.model.provider === resumed.model.provider && descriptor.model.modelId === resumed.model.id
					? resumed
					: undefined,
			searchProvider: () => search,
		});

		// A fresh open runs the bootstrap BEFORE resume: tools/prompt/engine
		// are installed from durable state.
		const reopened = await openChatRuntime(chat.id);
		const index = (await reopened.harness.snapshot(BackgroundRunsDoc, BACKGROUND_CONTEXT)) as unknown as {
			runs: Record<string, { conversationId: number; status: string }>;
		};
		const ref = index.runs[job.id]!;
		assert.equal(ref.status, "running", "the run stayed live across the close");

		await runner.runJob(job.id);
		const done = jobStore.getJob(job.id)!;
		assert.equal((done.result as ResearchResult).brief, BRIEF, "the recovered run finished with its answer");
		assert.equal(delivered.length, 1, "one result steer, never a duplicate");

		// No duplicate prompt: the conversation has ONE placed input, and the
		// resumed call reused it.
		const conversation = await reopened.harness.conversation(ref.conversationId as never, BACKGROUND_CONTEXT);
		assert.ok(conversation);
		let users = 0;
		let cursor: Record<string, unknown> | undefined;
		for (;;) {
			const page = await conversation!.entries({ order: "ascending" }, 256, cursor as never, BACKGROUND_CONTEXT);
			for (const entry of page.items) {
				if ((entry.model?.[0] as { role?: string } | undefined)?.role === "user") users++;
			}
			if (!page.next) break;
			cursor = page.next as Record<string, unknown>;
		}
		assert.equal(users, 1, "the resumed generation reused its committed input");
		assert.deepEqual(
			search.queries,
			["restart reattach", "after restart"],
			"the resumed generation ran the role tool installed from the descriptor",
		);

		researchModelOverride.current = undefined;
	});

	it("fails the reopen closed when a pending run's model cannot be restored, then resumes on repair", async () => {
		const chat = await chatStore.createChat("Durable: background fail closed");
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-failclosed" });
		const search = stubSearch();
		const delivered: SteerMessage[] = [];
		setTurnRunner(async () => 200);
		const runner = createJobRunner({
			chatStore,
			jobStore,
			deliver: async (steer) => {
				delivered.push(steer);
			},
			searchProvider: () => search,
		});

		researchModelOverride.current = fauxEngine([
			fauxAssistantMessage([fauxToolCall("web_search", { query: "fail closed" }, { id: "ws-failclosed" })], {
				stopReason: "toolUse",
			}),
			hangUntilAborted(),
		]);
		const first = runner.runJob(job.id, PROMPT_INPUT);
		await waitFor(() => (jobStore.getJob(job.id)!.usage?.steps ?? 0) >= 1, 10000, "first model call billed");
		await closeChatRuntime(chat.id);
		await first.catch(() => undefined);

		// The descriptor's model is no longer resolvable (settings changed,
		// endpoint edited, provider removed): the open must refuse to schedule.
		configureBackgroundRuns({ resolveEngine: () => undefined, searchProvider: () => search });
		await assert.rejects(
			() => openChatRuntime(chat.id),
			(error: unknown) => error instanceof ChatRuntimeInitError,
			"the reopen fails closed instead of running without its model",
		);
		assert.equal(jobStore.getJob(job.id)!.status, "running", "the pending job is neither settled nor lost");
		assert.equal(delivered.length, 0, "nothing was delivered from the unbound run");

		// Repair the selection and reopen: the same run resumes and finishes.
		const resumed = fauxEngine([fauxAssistantMessage([fauxText(BRIEF)])]);
		configureBackgroundRuns({ resolveEngine: () => resumed, searchProvider: () => search });
		const reopened = await openChatRuntime(chat.id);
		await runner.runJob(job.id);
		assert.equal((jobStore.getJob(job.id)!.result as ResearchResult).brief, BRIEF);
		assert.equal(delivered.length, 1, "one result steer after the repair");
		const index = (await reopened.harness.snapshot(BackgroundRunsDoc, BACKGROUND_CONTEXT)) as unknown as {
			runs: Record<string, { conversationId: number }>;
		};
		const conversation = await reopened.harness.conversation(
			index.runs[job.id]!.conversationId as never,
			BACKGROUND_CONTEXT,
		);
		assert.ok(conversation);
		let users = 0;
		let cursor: Record<string, unknown> | undefined;
		for (;;) {
			const page = await conversation!.entries({ order: "ascending" }, 256, cursor as never, BACKGROUND_CONTEXT);
			for (const entry of page.items) {
				if ((entry.model?.[0] as { role?: string } | undefined)?.role === "user") users++;
			}
			if (!page.next) break;
			cursor = page.next as Record<string, unknown>;
		}
		assert.equal(users, 1, "the repaired run reused its committed input");
		researchModelOverride.current = undefined;
	});
});
