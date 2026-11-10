/**
 * SCHEMA STAMPS (schema-versioning wave, owner 2026-10-10): LAZY v1 for
 * chats (record.version, stamped at the write choke point) and the graph
 * family (data/graph/format.json sidecar — ledgers, sources,
 * positions deliberately unversioned, rebuildable).
 * Honest refusal: records stamped NEWER than this build are refused on
 * read (the downgrade scenario) — never misparsed, never rewritten.
 *
 * Runs under an isolated LH_DATA_DIR (the chat-birth-stamp discipline:
 * the seam is set before any config-loading import, so every app-module
 * import is dynamic).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-stamps-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/session/store.ts");
const { CURRENT_CHAT_VERSION } = await import("../src/session/model/types.ts");
const { graphStore } = await import("../src/graph/store.ts");
const { GRAPH_FORMAT_FILE } = await import("../src/graph/files.ts");

test.after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

// ── chats: lazy stamp at the write choke point ──────────────────────────────

test("chats: createChat stamps the current version on disk", async () => {
	// v2 is the metadata-only shape: an old build (max v1) refuses it on read
	// instead of mistaking a transcript-less record for its own format.
	assert.equal(CURRENT_CHAT_VERSION, 2, "the transcript-less record is a new on-disk version");
	const r = await chatStore.createChat("stamp test");
	assert.equal(r.version, CURRENT_CHAT_VERSION, "the in-memory twin is stamped");
	const onDisk = JSON.parse(fs.readFileSync(path.join(TMP_DATA, "chats", `${r.id}.json`), "utf8"));
	assert.equal(onDisk.version, CURRENT_CHAT_VERSION, "the record carries the stamp");
});

test("chats: an UNSTAMPED legacy record reads fine (absence = legacy) and is stamped by its next write", async () => {
	const id = "chat_legacy000_stamp0";
	fs.mkdirSync(path.join(TMP_DATA, "chats"), { recursive: true });
	fs.writeFileSync(
		path.join(TMP_DATA, "chats", `${id}.json`),
		JSON.stringify({ id, title: "legacy", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] }),
		"utf-8",
	);
	const r = await chatStore.getChat(id);
	assert.ok(r, "unstamped record reads (absence reads as the pre-migration shape)");
	await chatStore.saveMessages(id, []);
	const onDisk = JSON.parse(fs.readFileSync(path.join(TMP_DATA, "chats", `${id}.json`), "utf8"));
	assert.equal(onDisk.version, CURRENT_CHAT_VERSION, "the write choke point stamped it");
});

test("chats: a NEWER-stamped record is refused honestly (the downgrade scenario)", async () => {
	const id = "chat_future000_stamp0";
	fs.writeFileSync(
		path.join(TMP_DATA, "chats", `${id}.json`),
		JSON.stringify({ id, title: "from the future", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [], version: 99 }),
		"utf-8",
	);
	assert.equal(await chatStore.getChat(id), null, "getChat refuses: reads as absent, never misparsed");
	assert.ok(!(await chatStore.listChats()).some((s) => s.id === id), "listChats skips it too");
	// and the refused record is NOT rewritten or downgraded by the visit:
	const onDisk = JSON.parse(fs.readFileSync(path.join(TMP_DATA, "chats", `${id}.json`), "utf8"));
	assert.equal(onDisk.version, 99, "the future record survives untouched");
});

// ── the graph family: the lazy format.json sidecar ──────────────────────────

test("graph: reads never write — no sidecar appears from reading alone", async () => {
	assert.ok(!fs.existsSync(GRAPH_FORMAT_FILE), "no sidecar before any write");
	assert.deepEqual(graphStore.readNodes(), [], "ledger reads fine without a sidecar");
	assert.ok(!fs.existsSync(GRAPH_FORMAT_FILE), "reads did NOT create the sidecar (lazy = write-side only)");
});

test("graph: the first ledger append creates the sidecar at version 1", async () => {
	graphStore.appendNode({
		id: "n_stamp0",
		name: "Stamps",
		statement: "The graph family carries one format sidecar.",
		aliases: [],
		createdAt: new Date().toISOString(),
		provenance: [],
	});
	assert.ok(fs.existsSync(GRAPH_FORMAT_FILE), "the first write stamped the family");
	assert.equal(JSON.parse(fs.readFileSync(GRAPH_FORMAT_FILE, "utf8")).version, 1);
	assert.equal(graphStore.readNodes().length, 1, "the ledger reads back with the sidecar present");
});

test("graph: a NEWER-stamped sidecar is refused honestly", async () => {
	fs.mkdirSync(path.dirname(GRAPH_FORMAT_FILE), { recursive: true });
	fs.writeFileSync(GRAPH_FORMAT_FILE, JSON.stringify({ version: 99 }), "utf-8");
	assert.throws(() => graphStore.readNodes(), /older than its data|format version 99/);
	assert.throws(() => graphStore.readSources(), /older than its data|format version 99/);
});

