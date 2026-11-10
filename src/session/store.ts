/**
 * ChatStore — the chat record adapter: METADATA in fs JSON, TRANSCRIPT in
 * the durable store (src/store/durable.ts).
 *
 * Implements core/ports.ts ChatStore; the record shapes live in
 * core/contracts.ts (ChatRecord/ChatSummary). One JSON file per chat keeps
 * everything that is not the transcript — title, timestamps, plan tree,
 * usage logs, settings, the schema stamp. The transcript is a read
 * projection over the chat's durable entries, so `getChat` is async: the
 * durable read is the truth, never a second cache.
 *
 * Wired in the composition root (src/server/stores.ts); nothing else
 * constructs it.
 */

import { isSafeId, mintId } from "../platform/model/index.ts";
import { readJsonFile, writeJsonAtomic } from "../platform/index.ts";
import { keyedLock } from "../platform/model/index.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../platform/index.ts";
import { emit } from "../platform/model/index.ts";
import type { ChatStore } from "./model/ports.ts";
import type { ChatRecord, ChatSettings, ChatSummary, ExtractionRunUsage, TurnUsage } from "./model/types.ts";
import type { PlanTree } from "./model/plan-types.ts";
import { CURRENT_CHAT_VERSION } from "./model/types.ts";
import type { LhMessage } from "./model/transcript.ts";
import { activeProblemOf, danglingQuestionOf } from "./model/transcript.ts";
import { phaseAt3Lh } from "./model/phases.ts";
import {
	appendMessages,
	closeChatRuntime,
	durableDir,
	readChatMessages,
	removeChatRuntimeFiles,
} from "./durable.ts";

/** The on-disk metadata record: everything except the transcript. */
type ChatMeta = Omit<ChatRecord, "messages">;

interface ParsedRecord {
	meta: ChatMeta;
}

const UNTITLED = "Untitled session";

function chatFile(id: string): string {
	if (!isSafeId(id)) throw new Error(`Invalid chat id: ${id}`);
	return path.join(PATHS.chats, `${id}.json`);
}

/** Per-chat record queue: every read-modify-write of a chat's metadata
 *  runs here, one at a time. */
const withMetaLock = keyedLock("chatMeta");

/** Parse the metadata file. Null for unknown, corrupt, or future-version
 *  records (the honest downgrade refusal: a read-modify-write store must
 *  never rewrite what it does not understand). */
function readRecord(id: string): ParsedRecord | null {
	const parsed = readJsonFile(chatFile(id));
	if (parsed === undefined) return null;
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_CHAT_VERSION) {
		console.error(
			`[chat ${id}] record stamped with schema version ${v} > ${CURRENT_CHAT_VERSION} — this app build is older; refusing to read it`,
		);
		return null;
	}
	const { messages: _transcript, ...meta } = parsed as ChatRecord;
	return { meta };
}

/** THE WRITE CHOKE POINT: every metadata persist goes through here and
 *  carries the CURRENT version stamp (lazy migration: existing files are
 *  stamped on their next write). */
function writeMeta(meta: ChatMeta): void {
	writeJsonAtomic(chatFile(meta.id), { ...meta, version: CURRENT_CHAT_VERSION });
}

/** THE RECORD BOUNDARY: every metadata read and write runs in the chat's
 *  queue. Null means unknown, corrupt, or newer-schema — refused before any
 *  runtime is opened. */
async function withRecord<T>(
	id: string,
	run: (parsed: ParsedRecord) => T | Promise<T>,
): Promise<T | null> {
	return withMetaLock(id, async () => {
		const parsed = readRecord(id);
		if (!parsed) return null;
		return run(parsed);
	});
}

/** One metadata mutation, persisted once. An unknown record is the callers'
 *  "Chat not found" contract. */
async function mutateMeta(id: string, update: (meta: ChatMeta) => ChatMeta | Promise<ChatMeta>): Promise<ChatMeta> {
	const meta = await withRecord(id, async (parsed) => {
		const next = await update(parsed.meta);
		writeMeta(next);
		return next;
	});
	if (!meta) throw new Error(`Chat not found: ${id}`);
	return meta;
}

/** The full record, or null if unknown / corrupt / newer-schema. */
async function getChat(id: string): Promise<ChatRecord | null> {
	const parsed = await withRecord(id, (record) => record);
	if (!parsed) return null;
	return { ...parsed.meta, messages: await readChatMessages(id) };
}

function createChat(title: string, kind?: "practice"): ChatRecord {
	const now = new Date().toISOString();
	const record: ChatRecord = {
		id: mintId("chat"),
		title: title.trim() || UNTITLED,
		createdAt: now,
		updatedAt: now,
		messages: [],
		// Practice sessions carry the marker; teach stays ABSENT (absence
		// reads as teach — pre-practice records never migrate).
		...(kind === "practice" ? { kind: "practice" as const } : {}),
	};
	const { messages: _messages, ...meta } = record;
	writeMeta(meta);
	emit("chats-changed", {});
	return { ...record, version: CURRENT_CHAT_VERSION };
}

/** Read chats three at a time: each read opens that chat's runtime. */
async function readInBatches(ids: string[], read: (id: string) => Promise<ChatRecord | null>): Promise<(ChatRecord | null)[]> {
	const out: (ChatRecord | null)[] = [];
	for (let i = 0; i < ids.length; i += 3) out.push(...(await Promise.all(ids.slice(i, i + 3).map(read))));
	return out;
}

function getChats(ids: string[]): Promise<(ChatRecord | null)[]> {
	return readInBatches(ids, getChat);
}

async function listChats(): Promise<ChatSummary[]> {
	fs.mkdirSync(PATHS.chats, { recursive: true });
	const names = fs.readdirSync(PATHS.chats).filter((f) => f.endsWith(".json"));
	const out: ChatSummary[] = [];
	const records = await readInBatches(names.map((name) => name.slice(0, -5)), (id) =>
		getChat(id).catch((error: unknown) => {
			console.error(`[chat ${id}] unreadable, left out of the list:`, error);
			return null;
		}),
	);
	for (const record of records) {
		if (!record) continue;
		// Per-record isolation: a record whose projection fails must not blank
		// the whole sidebar.
		try {
			const kind = record.kind ?? "teach";
			const summary: ChatSummary = {
				id: record.id,
				title: record.title,
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
				kind,
				messageCount: record.messages.length,
				phase: phaseAt3Lh(record.messages),
				pendingQuestion: danglingQuestionOf(record.messages) !== null,
				pendingProblem: kind === "practice" && activeProblemOf(record.messages) !== null,
				...(record.settings ? { settings: record.settings } : {}),
			};
			out.push(summary);
		} catch (err) {
			console.error(`[chat ${record.id}] summary projection failed:`, err);
		}
	}
	return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Upsert supplied native messages by id; omitted messages remain.
 *  New ids append, changed messages edit their existing entries.
 *  SILENT by the events law: callers emit their own record change. */
async function saveMessages(id: string, messages: LhMessage[]): Promise<void> {
	await mutateMeta(id, async (meta) => {
		await appendMessages(id, messages);
		return { ...meta, updatedAt: new Date().toISOString() };
	});
}

/** Mark conversation activity: `updatedAt` is the sidebar's sort key and the
 *  displayed "updated" time. The transcript writes themselves go to the
 *  durable store, so every accepted mutation boundary calls this. */
async function touchChat(id: string): Promise<void> {
	await mutateMeta(id, (meta) => ({ ...meta, updatedAt: new Date().toISOString() }));
}

/** Append one usage entry to the record's turn log — idempotent per turn
 *  id: each REQUEST carries its own id, so a replay of the same turn's
 *  persist appends once, while continuation turns (which share a response
 *  message id) each keep their usage. */
async function appendTurnUsage(id: string, entry: TurnUsage): Promise<void> {
	await mutateMeta(id, (meta) => {
		const turns = meta.turns ?? [];
		return { ...meta, turns: turns.some((t) => t.id === entry.id) ? turns : [...turns, entry] };
	});
}

/** Append one extraction-run usage entry — idempotent per startedAt. */
async function appendExtractionUsage(id: string, entry: ExtractionRunUsage): Promise<void> {
	await mutateMeta(id, (meta) => {
		const extractions = meta.extractions ?? [];
		return {
			...meta,
			extractions: extractions.some((r) => r.startedAt === entry.startedAt)
				? extractions
				: [...extractions, entry],
		};
	});
}

/** Persist the per-chat model/thinking settings — replace-whole. Like
 *  saveTree: a settings tweak is not conversation activity, so it
 *  deliberately does NOT bump updatedAt (sidebar order must not churn). */
async function saveSettings(id: string, settings: ChatSettings): Promise<void> {
	await mutateMeta(id, (meta) => ({ ...meta, settings }));
}

/** Rename a session. Like saveSettings, a rename is NOT conversation
 *  activity: updatedAt stays put so sidebar order never churns. */
async function renameChat(id: string, title: string): Promise<ChatRecord> {
	const renamed = await mutateMeta(id, (meta) => ({
		...meta,
		title: title.trim() || UNTITLED,
	}));
	emit("chats-changed", {});
	const record = await getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	return { ...record, ...renamed };
}

/** Hard-delete the session: close the runtime FIRST (no new work while it
 *  closes, admitted commits settled), then remove its database, journals,
 *  and the legacy backup, then the metadata file. False when the id is
 *  unknown; removal failures throw. The graph-ledger purge and job cleanup
 *  are the caller's choreography (core/graph-deletion.ts + the DELETE route). */
async function deleteChat(id: string): Promise<boolean> {
	// The metadata queue owns the whole removal: a mutation that arrives
	// afterwards re-reads the (now absent) file inside the same lock and
	// refuses, instead of rewriting metadata over a deleted runtime.
	return withMetaLock(id, async () => {
		const file = chatFile(id);
		const hadRecord = fs.existsSync(file);
		const hadRuntime = fs.existsSync(durableDir(id));
		await closeChatRuntime(id);
		removeChatRuntimeFiles(id);
		if (hadRecord) fs.unlinkSync(file);
		if (hadRecord || hadRuntime) emit("chats-changed", {}); // only a real removal — the present-entry law
		return hadRecord || hadRuntime;
	});
}

/** Persist the session plan tree (plan tools call this in execute).
 *  Deliberately does NOT bump updatedAt: tree mutations piggyback on the
 *  turn's saveMessages, and sidebar ordering shouldn't churn on tree edits. */
async function saveTree(id: string, tree: PlanTree): Promise<void> {
	await mutateMeta(id, (meta) => ({ ...meta, tree }));
}

export const chatStore: ChatStore = {
	createChat,
	getChat,
	getChats,
	listChats,
	saveMessages,
	touchChat,
	saveTree,
	saveSettings,
	renameChat,
	deleteChat,
	appendTurnUsage,
	appendExtractionUsage,
};
