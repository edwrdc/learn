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
 * LEGACY IMPORT (owner-approved): a record written before the migration
 * still carries `messages`. On first access the store copies the original
 * file byte-for-byte into the chat's runtime directory
 * (data/durable/<id>/legacy-chat.json), appends every message as a durable
 * entry, and only then rewrites the JSON without `messages`. The import is
 * idempotent — the empty-transcript check is the key — and the backup is
 * never deleted automatically (session deletion removes it with the rest).
 *
 * Wired in the composition root (src/server/stores.ts); nothing else
 * constructs it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { ChatStore } from "../core/ports.ts";
import type { ChatRecord, ChatSettings, ChatSummary, ExtractionRunUsage, PlanTree, TurnUsage } from "../core/contracts.ts";
import { CURRENT_CHAT_VERSION } from "../core/contracts.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { danglingQuestionOf } from "../core/native-messages.ts";
import { phaseAt3Lh } from "../core/phases.ts";
import {
	appendEntries,
	appendMessages,
	closeChatRuntime,
	draftForMessage,
	isEmptyTranscript,
	openChatRuntime,
	projectEntries,
	readEntries,
	removeChatRuntimeFiles,
} from "./durable.ts";

/** The on-disk metadata record: everything except the transcript. */
type ChatMeta = Omit<ChatRecord, "messages">;

interface ParsedRecord {
	meta: ChatMeta;
	/** Present only on a record written before the durable migration. */
	legacyMessages?: LhMessage[];
}

function chatFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
	return path.join(PATHS.chats, `${id}.json`);
}

/** Per-chat metadata write queue: the old store was synchronous, so its
 *  read-modify-write could not interleave. Async callers keep that
 *  ordering by chaining here. */
const metaQueues = new Map<string, Promise<unknown>>();

async function withMetaLock<T>(id: string, run: () => Promise<T>): Promise<T> {
	const previous = metaQueues.get(id) ?? Promise.resolve();
	const next = previous.then(run, run);
	metaQueues.set(
		id,
		next.catch(() => undefined),
	);
	try {
		return await next;
	} finally {
		if (metaQueues.get(id) === undefined) metaQueues.delete(id);
	}
}

/** Parse the metadata file. Null for unknown, corrupt, or future-version
 *  records (the honest downgrade refusal: a read-modify-write store must
 *  never rewrite what it does not understand). */
function readRecord(id: string): ParsedRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(chatFile(id), "utf-8"));
	} catch {
		return null;
	}
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_CHAT_VERSION) {
		console.error(
			`[chat ${id}] record stamped with schema version ${v} > ${CURRENT_CHAT_VERSION} — this app build is older; refusing to read it`,
		);
		return null;
	}
	const { messages, ...meta } = parsed as ChatRecord;
	return { meta, legacyMessages: Array.isArray(messages) ? messages : undefined };
}

/** THE WRITE CHOKE POINT: every metadata persist goes through here and
 *  carries the CURRENT version stamp (lazy migration: existing files are
 *  stamped on their next write). */
function writeMeta(meta: ChatMeta): void {
	fs.mkdirSync(PATHS.chats, { recursive: true });
	fs.writeFileSync(
		chatFile(meta.id),
		JSON.stringify({ ...meta, version: CURRENT_CHAT_VERSION }, null, "\t"),
		"utf-8",
	);
}

/** Import a pre-migration record: back up the original verbatim inside the
 *  chat's runtime directory, append its messages as durable entries, then
 *  drop `messages` from the metadata file. Idempotent: the transcript's
 *  emptiness is the key, so a crash between the entry commit and the JSON
 *  rewrite simply re-reads the same durable transcript on the next access. */
async function importLegacy(id: string, meta: ChatMeta, messages: LhMessage[]): Promise<void> {
	const runtime = await openChatRuntime(id);
	if (await isEmptyTranscript(runtime)) {
		const backup = path.join(runtime.dir, "legacy-chat.json");
		if (!fs.existsSync(backup)) fs.copyFileSync(chatFile(id), backup);
		await appendEntries(id, messages.map(draftForMessage));
	}
	writeMeta(meta);
}

async function readChat(id: string): Promise<ChatRecord | null> {
	const parsed = readRecord(id);
	if (!parsed) return null;
	if (parsed.legacyMessages !== undefined) {
		await importLegacy(id, parsed.meta, parsed.legacyMessages);
	}
	const runtime = await openChatRuntime(id);
	const messages = projectEntries(await readEntries(runtime));
	return { ...parsed.meta, messages };
}

function createChat(title: string, kind?: "practice"): ChatRecord {
	const now = new Date().toISOString();
	const record: ChatRecord = {
		id: `chat_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		title: title.trim() || "Untitled session",
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

/** The full record, or null if unknown / corrupt / newer-schema. */
async function getChat(id: string): Promise<ChatRecord | null> {
	return readChat(id);
}

async function listChats(): Promise<ChatSummary[]> {
	let names: string[];
	try {
		fs.mkdirSync(PATHS.chats, { recursive: true });
		names = fs.readdirSync(PATHS.chats).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	const out: ChatSummary[] = [];
	for (const name of names) {
		const record = await readChat(name.slice(0, -5)).catch(() => null);
		if (!record) continue;
		// Per-record isolation (Wave B): a record whose projection fails must
		// not blank the whole sidebar.
		try {
			const { messages, tree: _tree, turns: _turns, extractions: _extractions, ...summary } = record;
			out.push({
				...summary,
				// Normalized kind: absent record field reads as teach.
				kind: summary.kind ?? "teach",
				messageCount: messages.length,
				// Record-derived status for the session picker: phase from the
				// transcript's explicit events, pending question/problem from the
				// native dangling-call scans.
				phase: phaseAt3Lh(messages),
				pendingQuestion: danglingQuestionOf(messages) !== null,
			} as ChatSummary);
		} catch (err) {
			console.error(`[chat ${record.id}] summary projection failed:`, err);
		}
	}
	return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Persist the full native message list. The record IS the transcript, so
 *  only the messages the durable store does not hold yet are appended (the
 *  callers pass the whole desired list). SILENT by the events law — see the
 *  SILENCE LAW comment at createChat. */
async function saveMessages(id: string, messages: LhMessage[]): Promise<void> {
	await appendMessages(id, messages);
	await withMetaLock(id, async () => {
		const parsed = readRecord(id);
		if (!parsed) throw new Error(`Chat not found: ${id}`);
		writeMeta({ ...parsed.meta, updatedAt: new Date().toISOString() });
	});
}

/** Append one usage entry to the record's turn log — idempotent per turn
 *  id: each REQUEST carries its own id, so a replay of the same turn's
 *  persist appends once, while continuation turns (which share a response
 *  message id) each keep their usage. */
async function appendTurnUsage(id: string, entry: TurnUsage): Promise<void> {
	await withMetaLock(id, async () => {
		const parsed = readRecord(id);
		if (!parsed) throw new Error(`Chat not found: ${id}`);
		const turns = parsed.meta.turns ?? [];
		writeMeta({
			...parsed.meta,
			turns: turns.some((t) => t.id === entry.id) ? turns : [...turns, entry],
		});
	});
}

/** Append one extraction-run usage entry — idempotent per startedAt. */
async function appendExtractionUsage(id: string, entry: ExtractionRunUsage): Promise<void> {
	await withMetaLock(id, async () => {
		const parsed = readRecord(id);
		if (!parsed) throw new Error(`Chat not found: ${id}`);
		const extractions = parsed.meta.extractions ?? [];
		writeMeta({
			...parsed.meta,
			extractions: extractions.some((r) => r.startedAt === entry.startedAt)
				? extractions
				: [...extractions, entry],
		});
	});
}

/** Persist the per-chat model/thinking settings — replace-whole. Like
 *  saveTree: a settings tweak is not conversation activity, so it
 *  deliberately does NOT bump updatedAt (sidebar order must not churn). */
async function saveSettings(id: string, settings: ChatSettings): Promise<void> {
	await withMetaLock(id, async () => {
		const parsed = readRecord(id);
		if (!parsed) throw new Error(`Chat not found: ${id}`);
		writeMeta({ ...parsed.meta, settings });
	});
}

/** Rename a session. Like saveSettings, a rename is NOT conversation
 *  activity: updatedAt stays put so sidebar order never churns. */
async function renameChat(id: string, title: string): Promise<ChatRecord> {
	const renamed = await withMetaLock(id, async () => {
		const parsed = readRecord(id);
		if (!parsed) throw new Error(`Chat not found: ${id}`);
		const meta = { ...parsed.meta, title: title.trim() || "Untitled session" };
		writeMeta(meta);
		return meta;
	});
	emit("chats-changed", {});
	const record = await readChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	return { ...record, ...renamed };
}

/** Hard-delete the session: close the runtime FIRST (no new work while it
 *  closes, admitted commits settled), then remove its database, journals,
 *  and the legacy backup, then the metadata file. False when the id is
 *  unknown. The graph-ledger purge and job cleanup are the caller's
 *  choreography (core/graph-deletion.ts + the DELETE route). */
async function deleteChat(id: string): Promise<boolean> {
	const file = chatFile(id);
	const hadRecord = fs.existsSync(file);
	const hadRuntime = fs.existsSync(path.join(PATHS.data, "durable", id));
	try {
		await closeChatRuntime(id);
		removeChatRuntimeFiles(id);
		if (hadRecord) fs.unlinkSync(file);
		if (hadRecord || hadRuntime) emit("chats-changed", {}); // only a real removal — the present-entry law
		return hadRecord || hadRuntime;
	} catch {
		return false;
	}
}

/** Persist the session plan tree (plan tools call this in execute).
 *  Deliberately does NOT bump updatedAt: tree mutations piggyback on the
 *  turn's saveMessages, and sidebar ordering shouldn't churn on tree edits. */
async function saveTree(id: string, tree: PlanTree): Promise<void> {
	await withMetaLock(id, async () => {
		const parsed = readRecord(id);
		if (!parsed) throw new Error(`Chat not found: ${id}`);
		writeMeta({ ...parsed.meta, tree });
	});
}

export const chatStore: ChatStore = {
	createChat,
	getChat,
	listChats,
	saveMessages,
	saveTree,
	saveSettings,
	renameChat,
	deleteChat,
	appendTurnUsage,
	appendExtractionUsage,
};
