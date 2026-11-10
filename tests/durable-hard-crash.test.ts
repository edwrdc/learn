/**
 * HARD-CRASH recovery: a real foreground turn is SIGKILLed mid-model-call,
 * then a fresh process opens the same database. The committed input and the
 * completed tool round must not repeat; the interrupted call re-runs once,
 * and the app's usage/settle services land exactly once.
 *
 * This is not the clean-close recovery suite (tests/durable-foreground-
 * recovery.test.ts): the child never closes the Harness, never settles, and
 * leaves SQLite exactly as the kernel killed it.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-hard-crash-"));
process.env.LH_DATA_DIR = TMP;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { chatStore } = await import("../src/session/store.ts");
const { closeChatRuntime, openChatRuntime } = await import("../src/session/durable.ts");
const { isTurnRunning } = await import("../src/session/turn-liveness.ts");
const { readTurn } = await import("../src/session/turn-service.ts");
const { testEngines } = await import("./support-durable.ts");

const FIXTURE = path.join(import.meta.dirname, "fixtures", "hard-crash-child.mts");
const ROOT = path.resolve(import.meta.dirname, "..");

after(async () => {
	for (const chat of await chatStore.listChats().catch(() => [])) {
		await closeChatRuntime(chat.id).catch(() => undefined);
	}
	fs.rmSync(TMP, { recursive: true, force: true });
});

function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 20_000, what = "condition"): Promise<void> {
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

describe("hard-crash foreground recovery", { concurrency: false }, () => {
	it("SIGKILL mid-call: one input, the completed tool round is not repeated, the recovered turn settles once", async () => {
		const readyFile = path.join(TMP, "ready");
		const child = spawn(process.execPath, ["--import", "tsx", FIXTURE, TMP, readyFile], {
			cwd: ROOT,
			env: { ...process.env, LH_DATA_DIR: TMP, NODE_ENV: "test" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		try {
			await waitFor(() => fs.existsSync(readyFile), 20_000, "the interrupted model call");
		} finally {
			child.kill("SIGKILL");
		}
		const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			child.once("exit", (code, signal) => resolve({ code, signal }));
		});
		assert.equal(exited.signal, "SIGKILL", `the child must die hard, not close (stderr: ${stderr})`);

		// Read the id from the metadata file: opening the runtime here would
		// run the recovery bootstrap before the test installs its engine.
		const chatFiles = fs.readdirSync(path.join(TMP, "chats")).filter((file) => file.endsWith(".json"));
		assert.equal(chatFiles.length, 1, "the child created exactly one chat");
		const chatId = chatFiles[0]!.slice(0, -".json".length);

		// The recovered run's engine answers the interrupted call. The
		// descriptor (faux provider/model) is restored through the test seam.
		const resumed = createFauxCore({});
		let requests = 0;
		resumed.setResponses([
			() => {
				requests++;
				return fauxAssistantMessage("resumed answer");
			},
		]);
		testEngines.teacher = { model: resumed.getModel(), streamFn: resumed.streamSimple };

		const runtime = await openChatRuntime(chatId);
		await waitFor(async () => !(await isTurnRunning(chatId)), 20_000, "the recovered turn settles");
		const turn = await readTurn(runtime);
		assert.equal(turn?.settle, "settled", "the recovered turn applied its settle services");
		assert.equal(requests, 1, "only the interrupted model call re-ran");

		const record = (await chatStore.getChat(chatId))!;
		assert.equal(
			record.messages.filter((message) => message.role === "user" && message.content === "go").length,
			1,
			"the original input is not duplicated",
		);
		assert.equal(
			record.messages.filter((message) => message.role === "toolResult" && message.toolCallId === "call_crash").length,
			1,
			"the completed tool result is not repeated",
		);
		assert.equal(record.messages.filter((message) => message.role === "assistant").length, 2, "one completed step + one resumed answer");
		assert.equal(record.turns?.length, 1, "one TurnUsage for the turn");
		assert.equal(record.turns![0]!.steps.length, 2, "both completed steps billed once");
	});
});
