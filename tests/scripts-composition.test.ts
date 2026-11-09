/**
 * The shipped CLI extraction scripts must go through the composition root,
 * not wire their own pipeline: the background-run seam, the role→model
 * resolver and the key gate are all process-global wiring that only
 * chat-handler installs. Offline: temp data dir, faux engine, no keys.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-scripts-composition-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

const { chatStore } = await import("../src/session/store.ts");
const { closeChatRuntime } = await import("../src/session/durable.ts");
const { backgroundRun } = await import("../src/jobs/durable-run.ts");
const { boot } = await import("../src/boot.ts");

after(async () => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

describe("CLI extraction composition", () => {
	it("boot wires the background seam the scripts' extraction rides", async () => {
		await boot().recovered;
		const chat = await chatStore.createChat("Scripts: background seam");
		try {
			const faux = createFauxCore({});
			faux.setResponses([fauxAssistantMessage([fauxText("offline summary")])] as never);
			const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
			const result = await backgroundRun({
				jobId: "compact:scripts-smoke",
				chatId: chat.id,
				kind: "compact",
				role: "compact",
				engine,
				maxTurns: 1,
				systemPrompt: "Summarize.",
				prompt: "Summarize this.",
			});
			assert.equal(result.text, "offline summary");
		} finally {
			await closeChatRuntime(chat.id);
		}
	});
});
