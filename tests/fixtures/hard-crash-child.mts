/**
 * Hard-crash child: a real foreground turn that dies mid-model-call.
 *
 * Started by tests/durable-hard-crash.test.ts. It creates a chat, runs one
 * turn whose tool round completes, and hangs inside the second model call.
 * It writes the ready file from inside that call, then the parent SIGKILLs
 * the process (no close, no cleanup).
 */
import { writeFileSync } from "node:fs";
import { Type } from "typebox";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

const [dataDir, readyFile] = process.argv.slice(2);
if (!dataDir || !readyFile) throw new Error("usage: hard-crash-child.mts <dataDir> <readyFile>");
process.env.LH_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { chatStore } = await import("../../src/store/chats.ts");
const { handleChatRequest } = await import("../../src/server/chat-handler.ts");

const chat = await chatStore.createChat("hard crash");
await chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });

const faux = createFauxCore({});
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("again", {}, { id: "call_crash" })], { stopReason: "toolUse" }),
	() => {
		writeFileSync(readyFile, "ready");
		return new Promise<never>(() => {
			/* the interrupted model call: the parent kills this process here */
		});
	},
]);
const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
const again = {
	name: "again",
	description: "Continue",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
};

const ack = await handleChatRequest(
	new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: "go" } }),
	}),
	{ engine, tools: { again } },
);
if (ack.status !== 200) throw new Error(`turn refused: ${ack.status} ${await ack.text()}`);
setInterval(() => {
	/* keep the process alive until the parent kills it */
}, 1000);
await new Promise<never>(() => {});
