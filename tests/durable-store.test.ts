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
const {
	appendEntries,
	closeChatRuntime,
	durableDir,
	draftForMessage,
	openChatRuntime,
	peekChatRuntime,
	projectTranscript,
	readEntries,
} = await import("../src/store/durable.ts");
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

const legacyMessage = newUserMessage("old words");

/** The pre-migration on-disk shape: a v1 record that still carries the
 *  transcript in `messages`. */
function writeLegacyRecord(id: string): Buffer {
	const bytes = Buffer.from(
		JSON.stringify(
			{
				id,
				title: "legacy title",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-02T00:00:00.000Z",
				messages: [legacyMessage],
				version: 1,
			},
			null,
			"\t",
		),
	);
	fs.mkdirSync(path.dirname(chatFile(id)), { recursive: true });
	fs.writeFileSync(chatFile(id), bytes);
	return bytes;
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

test("repeated upserts of one message target its original entry, so the newest edit is the visible one", async () => {
	const chat = chatStore.createChat("edit-twice");
	const first = newUserMessage("first edit");
	const second = newUserMessage("second edit");
	await chatStore.saveMessages(chat.id, [first]);
	await chatStore.saveMessages(chat.id, [{ ...first, content: "first edit" }]);
	await chatStore.saveMessages(chat.id, [{ ...first, content: "second edit" }]);

	const record = await chatStore.getChat(chat.id);
	assert.deepEqual(record!.messages.map((m) => m.content), ["second edit"], "the newest edit is the record");
	assert.equal(record!.messages[0]!.id, first.id, "the app id is stable across edits");
	assert.deepEqual(toLlmMessages(record!.messages).map((m) => (m as { content: string }).content), ["second edit"], "the model sees the newest edit too");

	const runtime = await openChatRuntime(chat.id);
	const entries = await readEntries(runtime);
	assert.equal(entries.length, 3, "two immutable edit entries over the original");
	assert.deepEqual(entries[1]!.edits?.map((e) => e.target), [entries[0]!.id]);
	assert.deepEqual(entries[2]!.edits?.map((e) => e.target), [entries[0]!.id], "the second edit targets the ORIGINAL entry");
	const { entryOf } = projectTranscript(entries);
	assert.equal(entryOf.get(first.id), entries[0]!.id, "projected ids point at the original owner");

	const steer = {
		id: "steer_twice",
		role: "custom" as const,
		customType: "subagent-steer" as const,
		content: "done",
		display: true,
		details: { ui: 1 },
		timestamp: 3,
	};
	await chatStore.saveMessages(chat.id, [steer]);
	await chatStore.saveMessages(chat.id, [{ ...steer, details: { ui: 2 } }]);
	await chatStore.saveMessages(chat.id, [{ ...steer, details: { ui: 3 } }]);
	const marker = (await chatStore.getChat(chat.id))!.messages.find((m) => m.id === steer.id) as {
		details: { ui: number };
	};
	assert.deepEqual(marker.details, { ui: 3 }, "marker edits chain on the original marker entry too");
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

test("the legacy import queue is process-global: two module copies import once", async () => {
	// Next dev (and any `?route-copy` import) can load chats.ts twice. The
	// queue and the Harness handle map must be shared, or two simultaneous
	// first reads both see an empty transcript and append the same messages.
	const specifier = "../src/store/chats.ts?route-copy=2";
	const copy = (await import(specifier)) as typeof import("../src/store/chats.ts");
	assert.notEqual(copy.chatStore, chatStore, "the second module instance is distinct");
	const chat = chatStore.createChat("module copies");
	const legacy = {
		id: chat.id,
		title: "module copies",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		messages: [{ id: "msg_keep", role: "user", content: "keep", timestamp: 1 }],
	};
	fs.writeFileSync(chatFile(chat.id), JSON.stringify(legacy, null, "\t"));

	const [first, second] = await Promise.all([chatStore.getChat(chat.id), copy.chatStore.getChat(chat.id)]);
	assert.deepEqual(first!.messages, legacy.messages);
	assert.deepEqual(second!.messages, legacy.messages);
	const runtime = await openChatRuntime(chat.id);
	assert.equal((await readEntries(runtime)).length, 1, "imported exactly once across module instances");
	assert.equal(
		(JSON.parse(fs.readFileSync(chatFile(chat.id), "utf8")) as { messages?: unknown }).messages,
		undefined,
		"the metadata rewrite happened once",
	);
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

// ── the legacy record boundary ─────────────────────────────────────────────
// A pre-migration record carries its transcript in `messages`. EVERY access
// (read or metadata mutation) must complete the import first — a metadata
// write that ran without it stripped the transcript with no backup, and two
// concurrent first accesses each appended their own copy.

test("every metadata mutation imports the legacy transcript before it rewrites the record", async () => {
	const mutations: Array<{
		name: string;
		run: (id: string) => Promise<unknown>;
		meta: (meta: Record<string, unknown>) => void;
	}> = [
		{
			name: "saveSettings",
			run: (id) => chatStore.saveSettings(id, { model: { provider: "openrouter", id: "x" } }),
			meta: (meta) => assert.deepEqual(meta.settings, { model: { provider: "openrouter", id: "x" } }),
		},
		{
			name: "saveTree",
			run: (id) => chatStore.saveTree(id, { nodes: [], edges: [], current: null } as never),
			meta: (meta) => assert.deepEqual(meta.tree, { nodes: [], edges: [], current: null }),
		},
		{
			name: "appendTurnUsage",
			run: (id) =>
				chatStore.appendTurnUsage(id, {
					id: "turn_legacy",
					messageId: "m1",
					at: "2026-11-01T00:00:00.000Z",
					model: "faux:x",
					steps: [],
				}),
			meta: (meta) => assert.equal((meta.turns as unknown[]).length, 1),
		},
		{
			name: "appendExtractionUsage",
			run: (id) =>
				chatStore.appendExtractionUsage(id, {
					startedAt: 7,
					at: "2026-11-01T00:00:00.000Z",
					durationMs: 5,
					stages: {
						extractor: { model: "faux:x", steps: [] },
						auditor: { model: "faux:x", steps: [] },
					},
				}),
			meta: (meta) => assert.equal((meta.extractions as unknown[]).length, 1),
		},
		{
			name: "renameChat",
			run: (id) => chatStore.renameChat(id, "renamed"),
			meta: (meta) => assert.equal(meta.title, "renamed"),
		},
		{
			// The client re-POSTs its whole list, but a stale one may not
			// carry the old messages: the import runs first, so they survive.
			name: "saveMessages",
			run: (id) => chatStore.saveMessages(id, [newUserMessage("new words")]),
			meta: (meta) => assert.notEqual(meta.updatedAt, "2026-01-02T00:00:00.000Z"),
		},
	];
	for (const mutation of mutations) {
		const id = `chat_lm_${mutation.name}`;
		const original = writeLegacyRecord(id);

		await mutation.run(id);

		const record = await chatStore.getChat(id);
		assert.ok(record, `${mutation.name}: the record still reads`);
		const ids = record.messages.map((m) => m.id);
		assert.deepEqual(
			ids.filter((messageId) => messageId === legacyMessage.id),
			[legacyMessage.id],
			`${mutation.name}: the legacy message survives exactly once`,
		);
		assert.deepEqual(
			fs.readFileSync(path.join(durableDir(id), "legacy-chat.json")),
			original,
			`${mutation.name}: the original bytes are backed up`,
		);
		const meta = JSON.parse(fs.readFileSync(chatFile(id), "utf-8")) as Record<string, unknown>;
		assert.equal(meta.messages, undefined, `${mutation.name}: the metadata drops the transcript`);
		assert.equal(meta.version, CURRENT_CHAT_VERSION, `${mutation.name}: the migrated record carries the current stamp`);
		assert.equal(meta.title, mutation.name === "renameChat" ? "renamed" : "legacy title");
		mutation.meta(meta);
		if (mutation.name === "saveMessages") {
			assert.deepEqual(record.messages.map((m) => m.content), ["old words", "new words"]);
		}
	}
});

test("simultaneous first reads import the legacy record exactly once", async () => {
	const id = "chat_lm_parallel_reads";
	writeLegacyRecord(id);

	const [first, second] = await Promise.all([chatStore.getChat(id), chatStore.getChat(id)]);

	assert.deepEqual(first!.messages.map((m) => m.id), [legacyMessage.id]);
	assert.deepEqual(second!.messages.map((m) => m.id), [legacyMessage.id]);
	const runtime = await openChatRuntime(id);
	assert.equal((await readEntries(runtime)).length, 1, "one durable entry, not one per reader");
});

test("a sidebar list racing a detail read imports once", async () => {
	const id = "chat_lm_list_race";
	writeLegacyRecord(id);

	const [list, record] = await Promise.all([chatStore.listChats(), chatStore.getChat(id)]);

	assert.ok(list.some((summary) => summary.id === id));
	assert.deepEqual(record!.messages.map((m) => m.id), [legacyMessage.id]);
	const runtime = await openChatRuntime(id);
	assert.equal((await readEntries(runtime)).length, 1);
});

test("a first read racing a metadata mutation imports once", async () => {
	const id = "chat_lm_read_write_race";
	writeLegacyRecord(id);

	const [record, renamed] = await Promise.all([chatStore.getChat(id), chatStore.renameChat(id, "renamed")]);

	assert.deepEqual(record!.messages.map((m) => m.id), [legacyMessage.id]);
	assert.deepEqual(renamed.messages.map((m) => m.id), [legacyMessage.id]);
	assert.equal(renamed.title, "renamed");
	const runtime = await openChatRuntime(id);
	assert.equal((await readEntries(runtime)).length, 1);
});

test("a current-version record without messages is never treated as legacy", async () => {
	const chat = chatStore.createChat("migrated shape");
	const meta = JSON.parse(fs.readFileSync(chatFile(chat.id), "utf-8")) as Record<string, unknown>;
	assert.equal(meta.messages, undefined, "the transcript lives in the durable store");
	assert.equal(meta.version, CURRENT_CHAT_VERSION);

	const record = await chatStore.getChat(chat.id);
	assert.deepEqual(record!.messages, []);
	assert.equal(
		fs.existsSync(path.join(durableDir(chat.id), "legacy-chat.json")),
		false,
		"no legacy backup is invented for a migrated record",
	);
});

// ── runtime lifecycle ──────────────────────────────────────────────────────
// Closing must keep the chat's one handle slot until the Harness has drained:
// otherwise a caller can open a SECOND Harness on the same database while the
// first is still closing.

test("a closing runtime refuses a second open and new appends, then reopens", async () => {
	const chat = chatStore.createChat("close race");
	await chatStore.saveMessages(chat.id, [newUserMessage("hi")]);
	const runtime = await openChatRuntime(chat.id);

	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	runtime.queue = runtime.queue.then(() => gate);

	const closing = closeChatRuntime(chat.id);
	await assert.rejects(openChatRuntime(chat.id), /is closing/, "the closing runtime keeps the handle slot");
	await assert.rejects(
		appendEntries(chat.id, [draftForMessage(newUserMessage("too late"))]),
		/is closing/,
		"new work is refused while closing",
	);

	release();
	await closing;
	assert.equal(peekChatRuntime(chat.id), undefined, "the slot is released once the close settles");

	const reopened = await openChatRuntime(chat.id);
	assert.notEqual(reopened, runtime, "a fresh Harness opens after the close");
	assert.deepEqual((await chatStore.getChat(chat.id))!.messages.map((m) => m.content), ["hi"]);
});

test("concurrent first opens share the chat's one Harness", async () => {
	const chat = chatStore.createChat("open fan-out");
	const runtimes = await Promise.all(Array.from({ length: 8 }, () => openChatRuntime(chat.id)));
	assert.ok(
		runtimes.every((runtime) => runtime === runtimes[0]),
		"every concurrent caller gets the same runtime — the slot map is the owner",
	);
});
