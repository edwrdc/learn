/**
 * The shipped learnharness skill reader against a real migrated chat store.
 *
 * Builds format-2 chats through src/store (the pinned pi-durable library),
 * including native entries without record ids, an answer ContextEdit over a
 * stored pose placeholder, a legacy v1 import, and an open-WAL commit, then
 * drives the Python reader. Checks the projection and that reads change no
 * file in the data folder.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-durable-reader-"));
process.env.LH_DATA_DIR = TMP;

const { chatStore } = await import("../src/store/chats.ts");
const {
	appendEntries,
	appendEntry,
	closeChatRuntime,
	draftForMessage,
	editDraftFor,
	openChatRuntime,
	projectEntries,
	readEntries,
} = await import("../src/store/durable.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");
type LhMessage = import("../src/core/native-messages.ts").LhMessage;
type Message = import("@earendil-works/pi-ai").Message;

const PYTHON = process.env.PYTHON ?? "python3";
const SCRIPTS = path.join(import.meta.dirname, "..", "skills", "learnharness", "scripts");
const READER = spawnSync(PYTHON, ["--version"]).status === 0 ? undefined : "python3 is unavailable";
const POSE_ACK = "Question posed — the turn ends here; the learner's graded answer arrives as this call's result.";
const USAGE = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test.after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

function cli(script: "sessions.py" | "graph.py", args: string[]): string {
	const result = spawnSync(PYTHON, ["-B", path.join(SCRIPTS, script), "--data-dir", TMP, ...args], {
		encoding: "utf8",
		env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

function snapshot(folder: string): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (current: string): void => {
		for (const name of fs.readdirSync(current)) {
			const target = path.join(current, name);
			if (fs.statSync(target).isDirectory()) walk(target);
			else files[path.relative(folder, target)] = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
		}
	};
	walk(folder);
	return files;
}

test("the reader projects native entries, edits, and ids like the app", { skip: READER }, async () => {
	const chat = chatStore.createChat("reader projection");
	await chatStore.saveMessages(chat.id, [
		newUserMessage("teach me joins"),
		{
			id: "msg_reader_assistant",
			role: "assistant",
			content: [
				{ type: "text", text: "A join combines rows." },
				{ type: "toolCall", id: "call_quiz_live", name: "quiz", arguments: { question: "q" } },
			],
			timestamp: 2,
			api: "fixture",
			provider: "fixture",
			model: "fixture",
			usage: USAGE,
			stopReason: "toolUse",
		},
	]);
	await appendEntries(chat.id, [
		{ kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "Native durable reply." }], timestamp: 3, api: "fixture", provider: "fixture", model: "fixture", usage: USAGE, stopReason: "stop" }] },
		{
			kind: "pi.toolResult",
			model: [{ role: "toolResult", toolCallId: "call_quiz_live", toolName: "quiz", content: [{ type: "text", text: POSE_ACK }], details: null, isError: false, timestamp: 4 } as Message],
		},
	]);
	const runtime = await openChatRuntime(chat.id);
	const pose = (await readEntries(runtime)).find((entry) => (entry.model?.[0] as { toolCallId?: string })?.toolCallId === "call_quiz_live");
	assert.ok(pose, "the stored pose placeholder exists");
	const answer = {
		id: "msg_reader_answer",
		role: "toolResult",
		toolCallId: "call_quiz_live",
		toolName: "quiz",
		content: [{ type: "text", text: '{"kind":"quiz"}' }],
		details: { kind: "quiz", text: "learner answer", thinking: "learner thought" },
		isError: false,
		timestamp: 5,
	} as LhMessage;
	await appendEntry(chat.id, editDraftFor(pose!.id, answer));
	const expected = projectEntries(await readEntries(runtime));
	await closeChatRuntime(chat.id);

	const before = snapshot(TMP);
	const selected = JSON.parse(cli("sessions.py", ["--format", "json", "read", chat.id])) as {
		record: { messages: Array<{ id: string; role: string; details?: { text?: string } }> };
	};
	assert.deepEqual(selected.record.messages.map((message) => message.id), expected.map((message) => message.id));
	assert.deepEqual(selected.record.messages.find((message) => message.id === "msg_reader_answer")?.details, {
		kind: "quiz",
		text: "learner answer",
		thinking: "learner thought",
	}, "the answer replacement is the projected message");
	assert.ok(expected.some((message) => /^e\d+$/.test(message.id)), "a native entry derives e<entry-id>");
	const markdown = cli("sessions.py", ["read", chat.id]);
	assert.match(markdown, /learner answer/);
	assert.match(markdown, /Native durable reply/);
	assert.doesNotMatch(markdown, /no learner answer recorded/, "a replaced pose is not shown as pending");
	const listed = JSON.parse(cli("sessions.py", ["--format", "json", "list"])) as { sessions: Array<{ id: string }> };
	assert.ok(listed.sessions.some((session) => session.id === chat.id));
	assert.deepEqual(snapshot(TMP), before, "reader commands changed no data file");
});

test("a legacy v1 chat imports once and the backup is never the transcript", { skip: READER }, async () => {
	const chat = chatStore.createChat("legacy reader");
	const legacyMessages = [
		{ id: "msg_legacy_user", role: "user", content: "old words", timestamp: 1 },
		{ id: "msg_legacy_assistant", role: "assistant", content: [{ type: "text", text: "old reply" }], timestamp: 2, api: "fixture", provider: "fixture", model: "fixture", usage: USAGE, stopReason: "stop" },
	];
	const legacy = { id: chat.id, title: "Legacy reader title", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", version: 1, messages: legacyMessages };
	fs.writeFileSync(path.join(TMP, "chats", `${chat.id}.json`), JSON.stringify(legacy, null, "\t"));
	const imported = await chatStore.getChat(chat.id);
	assert.deepEqual(imported?.messages.map((message) => message.id), legacyMessages.map((message) => message.id));
	await closeChatRuntime(chat.id);

	const metadata = JSON.parse(fs.readFileSync(path.join(TMP, "chats", `${chat.id}.json`), "utf-8")) as { version: number; messages?: unknown };
	assert.equal(metadata.version, 2);
	assert.equal(metadata.messages, undefined, "the migrated metadata file carries no transcript");
	const backup = path.join(TMP, "durable", chat.id, "legacy-chat.json");
	assert.ok(fs.existsSync(backup), "the original record is backed up");
	fs.writeFileSync(backup, JSON.stringify({ ...legacy, messages: [{ id: "msg_backup_only", role: "user", content: "BACKUP STALE TEXT" }] }));

	const selected = JSON.parse(cli("sessions.py", ["--format", "json", "read", chat.id])) as { record: { title: string; messages: Array<{ id: string }> } };
	assert.equal(selected.record.title, "Legacy reader title");
	assert.deepEqual(selected.record.messages.map((message) => message.id), legacyMessages.map((message) => message.id));
	const markdown = cli("sessions.py", ["read", chat.id]);
	assert.match(markdown, /old words/);
	assert.match(markdown, /old reply/);
	assert.doesNotMatch(markdown, /BACKUP STALE TEXT/, "the legacy backup is not read as the current transcript");
});

test("a live WAL commit is visible and reading changes no database file", { skip: READER }, async () => {
	const chat = chatStore.createChat("wal reader");
	await chatStore.saveMessages(chat.id, [newUserMessage("before the wal commit")]);
	const runtime = await openChatRuntime(chat.id);
	await appendEntries(chat.id, [draftForMessage({ id: "msg_wal_late", role: "user", content: "committed in wal", timestamp: 2 } as LhMessage)]);
	const expected = projectEntries(await readEntries(runtime));
	const folder = path.join(TMP, "durable", chat.id);
	assert.deepEqual(fs.readdirSync(folder).sort(), ["harness.sqlite", "harness.sqlite-shm", "harness.sqlite-wal"], "the writer holds uncheckpointed WAL state");

	const before = snapshot(folder);
	const selected = JSON.parse(cli("sessions.py", ["--format", "json", "read", chat.id])) as { record: { messages: Array<{ id: string }> } };
	assert.deepEqual(selected.record.messages.map((message) => message.id), expected.map((message) => message.id));
	assert.match(cli("sessions.py", ["read", chat.id]), /committed in wal/);
	assert.deepEqual(snapshot(folder), before, "the read created or changed no database, WAL, or shared-memory file");
	await closeChatRuntime(chat.id);
});

test("graph labels resolve migrated chats from metadata", { skip: READER }, async () => {
	const chat = chatStore.createChat("graph label reader");
	const user = newUserMessage("graph provenance words");
	await chatStore.saveMessages(chat.id, [user]);
	await closeChatRuntime(chat.id);
	fs.mkdirSync(path.join(TMP, "graph"), { recursive: true });
	fs.appendFileSync(path.join(TMP, "graph", "nodes.jsonl"), `${JSON.stringify({
		id: "n_reader_fixture",
		name: "Reader fixture",
		statement: "A reader fixture proposition.",
		aliases: [],
		createdAt: "2026-11-01T00:00:00.000Z",
		provenance: [{ chatId: chat.id, messageId: user.id }],
	})}\n`);

	const sessions = JSON.parse(cli("graph.py", ["--format", "json", "sessions"])) as { records: Array<{ id: string; name: string; kind: string; propositions: number }> };
	const record = sessions.records.find((item) => item.id === chat.id);
	assert.equal(record?.name, "graph label reader");
	assert.equal(record?.kind, "chat");
	assert.equal(record?.propositions, 1);
});
