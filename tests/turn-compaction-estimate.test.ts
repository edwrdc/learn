import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-turn-compaction-estimate-"));
process.env.LH_DATA_DIR = data;
process.env.OPENROUTER_API_KEY = "test-key-presence-gate";
const { chatStore } = await import("../src/session/store.ts");
const { closeChatRuntime } = await import("../src/session/durable.ts");
const { newUserMessage } = await import("../src/session/model/transcript.ts");
const { handleChatInput } = await import("../src/session/turn.ts");
await import("./support-durable.ts");
const { services } = await import("../src/boot.ts");
const { runningTurn } = await import("../src/session/turn-runs.ts");
const { setBackgroundRun } = await import("../src/jobs/durable-run.ts");
const { writeSettings } = await import("../src/settings/store.ts");
const { promptOverrides } = await import("../src/settings/index.ts");

after(() => fs.rmSync(data, { recursive: true, force: true }));

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

it("the compaction gate counts the prompt the turn will actually send (phase + overrides)", { timeout: 15_000 }, async () => {
	// ~15k tokens of history: under the 32k threshold with the default teacher
	// prompt (~9k tokens), over it with the prober prompt this fresh chat runs
	// plus the user's ~20k-token override of its base segment.
	promptOverrides.writeOverride("system-prompt.md", "o".repeat(80_000));
	writeSettings({ version: 1, compaction: { thresholdTokens: 32_000 }, graph: { enabled: false }, agent: { prompts: { "system-prompt.md": true } } });
	const chat = chatStore.createChat("compaction estimate");
	await chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	await chatStore.saveMessages(chat.id, [newUserMessage("x".repeat(30_000)), newUserMessage("y".repeat(30_000))]);
	let compactions = 0;
	setBackgroundRun(async (request) => {
		assert.equal(request.kind, "compact");
		compactions++;
		return { text: "Earlier history.", state: { kind: "compact" }, capped: false, steps: [{ step: 1, model: "faux:test", usage, finishReason: "stop", tools: "" }] };
	});
	services().upkeep = true;
	try {
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage("Understood.")]);
		const res = await handleChatInput(chat.id, { type: "text", text: "go on" }, { engine: { model: faux.getModel(), streamFn: faux.streamSimple } });
		assert.equal(res.status, 200);
		const run = runningTurn(chat.id);
		if (run) await new Response(run.subscribe()).text();
		assert.equal(compactions, 1, "the turn compacted before it ran");
	} finally {
		services().upkeep = false;
		promptOverrides.deleteOverride("system-prompt.md");
		await closeChatRuntime(chat.id);
	}
});
