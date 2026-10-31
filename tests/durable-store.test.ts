/**
 * The durable chat store (src/store/durable.ts + src/store/chats.ts):
 * per-chat SQLite transcript, the awaited read projection, the legacy
 * import, and hard deletion.
 *
 * Hermetic: LH_DATA_DIR points at a temp dir BEFORE the first config-loading
 * import (the chat-birth-stamp discipline).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-durable-store-"));
process.env.LH_DATA_DIR = TMP;

const { chatStore } = await import("../src/store/chats.ts");
const { durableDir, openChatRuntime, projectTranscript, readEntries } = await import("../src/store/durable.ts");
const { newMessageId, newPlanBlockMessage, newUserMessage, toLlmMessages } = await import(
	"../src/core/native-messages.ts"
);
type LhMessage = import("../src/core/native-messages.ts").LhMessage;
const { CURRENT_CHAT_VERSION } = await import("../src/core/contracts.ts");

test.after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

function chatFile(id: string): string {
	return path.join(TMP, "chats", `${id}.json`);
}

test("the transcript round-trips through durable entries with ids intact", async () => {
	const chat = chatStore.createChat("durable round trip");
	const messages: LhMessage[] = [
		newUserMessage("teach me joins"),
		{
			id: newMessageId(),
			role: "assistant",
			content: [
				{ type: "text", text: "A join combines rows." },
				{ type: "toolCall", id: "call_1", name: "quiz", arguments: { question: "q" } },
			],
			timestamp: 3,
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
		},
		{
			id: newMessageId(),
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "quiz",
			content: [{ type: "text", text: "Question posed" }],
			isError: false,
			timestamp: 4,
		},
	];
	await chatStore.saveMessages(chat.id, messages);
	const record = await chatStore.getChat(chat.id);
	assert.deepEqual(record!.messages, messages, "every message (and its id) comes back verbatim");
	assert.equal(fs.existsSync(chatFile(chat.id)), true, "the metadata file exists");
});

test("a marker's model face is its content; UI-only markers contribute nothing", async () => {
	const chat = chatStore.createChat("markers");
	const block = newPlanBlockMessage("call_plan", { kind: "full", at: "x", current: null, nodes: [], edges: [] });
	await chatStore.saveMessages(chat.id, [
		{ id: "steer_1", role: "custom", customType: "probe-handoff", content: "plan now", display: true, details: {}, timestamp: 1 },
		block,
	]);
	const record = await chatStore.getChat(chat.id);
	assert.deepEqual(record!.messages.map((m) => m.id), ["steer_1", block.id]);
	const runtime = await openChatRuntime(chat.id);
	const entries = await readEntries(runtime);
	const handoff = entries.find((e) => (e.data as { message?: { id?: string } })?.message?.id === "steer_1");
	const uiOnly = entries.find((e) => (e.data as { message?: { id?: string } })?.message?.id === block.id);
	assert.deepEqual(handoff!.model, [
		{ role: "user", content: [{ type: "text", text: "plan now" }], timestamp: 1 },
	], "the handoff flattens to its canonical user text at write time");
	assert.equal(uiOnly!.model, undefined, "a plan block never reaches the model");
});

test("an edited message is a ContextEdit over the entry that owns it", async () => {
	const chat = chatStore.createChat("edit");
	const steer = {
		id: "steer_artifact",
		role: "custom" as const,
		customType: "subagent-steer" as const,
		content: "done",
		display: true,
		details: { kind: "demo", ui: { inverted: false } },
		timestamp: 2,
	};
	await chatStore.saveMessages(chat.id, [steer]);
	await chatStore.saveMessages(chat.id, [{ ...steer, details: { kind: "demo", ui: { inverted: true } } }]);

	const record = await chatStore.getChat(chat.id);
	assert.equal(record!.messages.length, 1, "the edit replaces in place — no duplicate");
	const edited = record!.messages[0] as { details: { ui: { inverted: boolean } } };
	assert.deepEqual(edited.details.ui, { inverted: true });

	const runtime = await openChatRuntime(chat.id);
	const entries = await readEntries(runtime);
	assert.equal(entries.length, 2, "the log keeps both entries (immutable history)");
	assert.deepEqual(entries[1]!.edits?.map((e) => e.target), [entries[0]!.id]);
});

test("metadata (tree, settings, usage logs) lives in the JSON, not the transcript", async () => {
	const chat = chatStore.createChat("metadata", "practice");
	await chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "x" } });
	await chatStore.saveTree(chat.id, { nodes: [], edges: [], current: null } as never);
	await chatStore.appendTurnUsage(chat.id, {
		id: "turn_1",
		messageId: "m1",
		at: "2026-11-01T00:00:00.000Z",
		model: "faux:x",
		steps: [{ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }],
	});
	await chatStore.appendTurnUsage(chat.id, {
		id: "turn_1",
		messageId: "m1",
		at: "2026-11-01T00:00:00.000Z",
		model: "faux:x",
		steps: [],
	});
	await chatStore.appendExtractionUsage(chat.id, {
		startedAt: 1,
		at: "2026-11-01T00:00:00.000Z",
		durationMs: 5,
		stages: {
			extractor: { model: "faux:x", steps: [] },
			auditor: { model: "faux:x", steps: [] },
		},
	});

	const record = await chatStore.getChat(chat.id);
	assert.equal(record!.kind, "practice");
	assert.deepEqual(record!.settings, { model: { provider: "openrouter", id: "x" } });
	assert.deepEqual(record!.tree, { nodes: [], edges: [], current: null });
	assert.equal(record!.turns?.length, 1, "usage appends are idempotent per turn id");
	assert.equal(record!.extractions?.length, 1);
});

test("legacy import is idempotent across retries and a crash between commit and rewrite", async () => {
	const chat = chatStore.createChat("legacy");
	const legacy = {
		id: chat.id,
		title: "legacy title",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		messages: [newUserMessage("old words"), { id: "msg_legacy_1", role: "user", content: "again", timestamp: 2 }],
	};
	fs.writeFileSync(chatFile(chat.id), JSON.stringify(legacy, null, "\t"));

	const first = await chatStore.getChat(chat.id);
	assert.deepEqual(first!.messages, legacy.messages, "the legacy transcript imports");
	assert.equal(first!.title, "legacy title");

	// A crash between the entry commit and the metadata rewrite leaves the
	// legacy file intact — the next access must not import a second copy.
	fs.writeFileSync(chatFile(chat.id), JSON.stringify(legacy, null, "\t"));
	const second = await chatStore.getChat(chat.id);
	assert.deepEqual(second!.messages, legacy.messages, "re-import is a no-op: the transcript is the key");
	const backup = path.join(durableDir(chat.id), "legacy-chat.json");
	assert.deepEqual(fs.readFileSync(backup), Buffer.from(JSON.stringify(legacy, null, "\t")), "the backup is the original bytes");
});

test("a record stamped newer than this build is refused, never rewritten", async () => {
	const chat = chatStore.createChat("future");
	const raw = JSON.parse(fs.readFileSync(chatFile(chat.id), "utf-8")) as Record<string, unknown>;
	fs.writeFileSync(chatFile(chat.id), JSON.stringify({ ...raw, version: CURRENT_CHAT_VERSION + 1 }, null, "\t"));
	const before = fs.readFileSync(chatFile(chat.id));
	assert.equal(await chatStore.getChat(chat.id), null, "the downgrade reads as absent");
	assert.deepEqual(fs.readFileSync(chatFile(chat.id)), before, "and the file is untouched");
});

test("hard deletion closes the runtime, removes the database and backup, and is retryable", async () => {
	const chat = chatStore.createChat("delete me");
	await chatStore.saveMessages(chat.id, [newUserMessage("hi")]);
	const dir = durableDir(chat.id);
	assert.equal(fs.existsSync(dir), true);

	assert.equal(await chatStore.deleteChat(chat.id), true);
	assert.equal(fs.existsSync(dir), false, "the runtime directory is gone");
	assert.equal(fs.existsSync(chatFile(chat.id)), false, "the metadata file is gone");
	assert.equal(await chatStore.getChat(chat.id), null, "a deleted chat does not resurrect");
	assert.equal(await chatStore.deleteChat(chat.id), false, "a second delete is a clean false");
});

test("the projection applies edits and keeps the full history for export", async () => {
	const chat = chatStore.createChat("history");
	const messages = [newUserMessage("one"), newUserMessage("two")];
	await chatStore.saveMessages(chat.id, messages);
	await chatStore.saveMessages(chat.id, [{ ...messages[0]!, content: "one (edited)" }]);
	const record = await chatStore.getChat(chat.id);
	assert.deepEqual(record!.messages.map((m) => m.content), ["one (edited)", "two"]);
	// The model-facing flattening still yields a legal provider list.
	const wire = toLlmMessages(record!.messages);
	assert.equal(wire.length, 2);
	assert.ok(wire.every((m) => !("id" in m)), "record ids never reach the provider");
});

test("projectTranscript maps every projected id back to its owning entry", async () => {
	const chat = chatStore.createChat("index");
	const message = newUserMessage("hello");
	await chatStore.saveMessages(chat.id, [message]);
	const runtime = await openChatRuntime(chat.id);
	const { messages, entryOf } = projectTranscript(await readEntries(runtime));
	assert.equal(messages.length, 1);
	assert.equal(entryOf.get(message.id), (await readEntries(runtime))[0]!.id);
});
