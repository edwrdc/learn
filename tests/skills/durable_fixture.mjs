// Test-only fixture writer for the durable transcript reader.
//
// Creates a real per-chat pi-durable database through the app's own store
// module (src/store/durable.ts) and prints the app projection, so tests can
// compare the Python reader against the implementation instead of a
// hand-authored SQL shape. Runtime readers never invoke this file.
//
//   node tests/skills/durable_fixture.mjs <data-dir> <chat-id> build
//   node tests/skills/durable_fixture.mjs <data-dir> <chat-id> wal
//
// `wal` prints one JSON line, keeps the database open with its WAL
// uncheckpointed, and waits on stdin: `append` commits one more turn and
// prints it, `close` closes the runtime and exits.

import fs from "node:fs";
import * as readline from "node:readline";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const [dataDir, chatId, mode] = process.argv.slice(2);
if (!dataDir || !chatId || !["build", "wal"].includes(mode)) {
	console.error("usage: durable_fixture.mjs <data-dir> <chat-id> build|wal");
	process.exit(2);
}
process.env.LH_DATA_DIR = path.resolve(dataDir);

const here = path.dirname(fileURLToPath(import.meta.url));
const store = await import(path.join(here, "../../src/session/durable.ts"));
const native = await import(path.join(here, "../../src/session/model/transcript.ts"));
const { appendEntries, closeChatRuntime, draftForMessage, editDraftFor, openChatRuntime, projectEntries, readEntries } = store;
const { newAnswerResult } = native;

const ANSWER = newAnswerResult("call_quiz_1", "quiz", {
	kind: "quiz",
	questionText: "Which claim follows?",
	options: [{ index: 1, label: "A claim" }],
	answers: [{ index: 1, label: "A claim", value: "a" }],
	correct: true,
	thinking: "learner reasoning",
});
const POSE_ACK = "Question posed — the turn ends here; the learner's graded answer arrives as this call's result.";
const assistant = {
	id: "msg_assistant_1",
	role: "assistant",
	content: [
		{ type: "text", text: "A join combines rows from two tables." },
		{ type: "toolCall", id: "call_quiz_1", name: "quiz", arguments: { question: "Which claim follows?", options: [{ label: "A claim", value: "a" }], correctAnswer: "a" } },
		{ type: "toolCall", id: "call_probe_2", name: "probe", arguments: { question: "Pending probe", options: [{ label: "Still open", value: "open" }], correctAnswer: "open" } },
	],
	timestamp: 2,
	provider: "fixture",
	model: "fixture",
	usage: { input: 1, output: 2, totalTokens: 3 },
	stopReason: "toolUse",
};

function drafts() {
	return [
		draftForMessage({ id: "msg_user_1", role: "user", content: "teach me joins", timestamp: 1 }),
		draftForMessage(assistant),
		draftForMessage({ id: "msg_context_1", role: "custom", customType: "graph-context", content: "injected graph context", display: true, details: { propositions: [{ id: "n_one", name: "Join" }], chains: [] }, timestamp: 3 }),
		// Native durable entries carry no record data; the projection derives their ids.
		{ kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "Native reply without a stamped id." }], timestamp: 4, provider: "fixture", model: "fixture", usage: {}, stopReason: "stop" }] },
		{ kind: "pi.toolResult", model: [{ role: "toolResult", toolCallId: "call_native_1", toolName: "read", content: [{ type: "text", text: "native tool output" }], isError: false, timestamp: 5 }] },
		// The runtime's pose results: clean placeholders until the learner answers.
		{ kind: "pi.toolResult", model: [{ role: "toolResult", toolCallId: "call_quiz_1", toolName: "quiz", content: [{ type: "text", text: POSE_ACK }], details: null, isError: false, timestamp: 6 }] },
		{ kind: "pi.toolResult", model: [{ role: "toolResult", toolCallId: "call_probe_2", toolName: "probe", content: [{ type: "text", text: POSE_ACK }], details: null, isError: false, timestamp: 7 }] },
		{ kind: "lh.continuation", model: [{ role: "user", content: [{ type: "text", text: "[continue]" }], timestamp: 8 }] },
		{ kind: "pi.system", model: [{ role: "system", content: [], timestamp: 9 }] },
		draftForMessage({ id: "msg_practice_1", role: "custom", customType: "practice-thinking", content: "practice trace", display: true, details: { text: "learner practice trace", problemCallId: "call_problem_1" }, timestamp: 10 }),
	];
}

async function appendLate() {
	await appendEntries(chatId, [
		draftForMessage({ id: "msg_user_2", role: "user", content: "late committed turn", timestamp: 11 }),
	]);
}

fs.mkdirSync(path.join(dataDir, "chats"), { recursive: true });
fs.writeFileSync(
	path.join(dataDir, "chats", `${chatId}.json`),
	JSON.stringify({ id: chatId, title: "Durable fixture session", kind: "teach", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z", version: 2 }, null, "\t"),
);

const runtime = await openChatRuntime(chatId);
await appendEntries(chatId, drafts());
const entries = await readEntries(runtime);
const target = (toolCallIdOrMessageId) => {
	const entry = entries.find((candidate) => candidate.data?.message?.id === toolCallIdOrMessageId
		|| candidate.data?.id === toolCallIdOrMessageId
		|| candidate.model?.[0]?.toolCallId === toolCallIdOrMessageId);
	if (!entry) throw new Error(`entry not found for ${toolCallIdOrMessageId}`);
	return entry.id;
};
const practiceOld = { id: "msg_practice_old", role: "custom", customType: "practice-thinking", content: "old edit", display: true, details: { text: "old practice trace" }, timestamp: 12 };
const practiceNew = { id: "msg_practice_new", role: "custom", customType: "practice-thinking", content: "new edit", display: true, details: { text: "new practice trace" }, timestamp: 13 };
await appendEntries(chatId, [
	editDraftFor(target("call_quiz_1"), ANSWER),
	editDraftFor(target("msg_practice_1"), practiceOld),
	editDraftFor(target("msg_practice_1"), practiceNew),
]);

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
// The skill hides pi.system bookkeeping (the integration contract). The app
// projection keeps those entries today, so drop them from the expected list.
const projection = async () => projectEntries(await readEntries(runtime)).filter((message) => message.role !== "system");
if (mode === "build") {
	await appendLate();
	emit({ chatId, expected: await projection() });
	await closeChatRuntime(chatId);
} else {
	emit({ chatId, ready: true, expected: await projection() });
	const lines = readline.createInterface({ input: process.stdin });
	for await (const line of lines) {
		if (line.trim() === "append") {
			await appendLate();
			emit({ appended: true, expected: await projection() });
		}
		if (line.trim() === "close") break;
	}
	lines.close();
	await closeChatRuntime(chatId);
	process.exit(0);
}
