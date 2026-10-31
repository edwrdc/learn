/**
 * THE DURABLE CHAT STORE (pi-durable migration, owner-approved 2026-11-01).
 *
 * One SQLite database per PUBLIC chat id at PATHS.durable/<chatId>/. The
 * database has exactly ONE Harness owner in this process (the handle map
 * below — globalThis because Next dev hands every route its own module
 * instance). The chat's own transcript is the ROOT conversation; job and
 * sub-agent conversations share the file.
 *
 * TRANSCRIPT OWNERSHIP. Durable entries are the transcript. The app's
 * ChatRecord.messages is a READ PROJECTION over every entry in ascending
 * order (never the compacted model-context window), with ContextEdits
 * applied — the same substitution the model sees. App message ids ride
 * entry data (`data.id`, `data.message`), so imported ids keep chat URLs,
 * coverage fingerprints, graph provenance, and compaction cuts intact.
 *
 * Metadata (title, timestamps, plan tree, usage logs, settings) stays in
 * data/chats/<id>.json — see chats.ts, which owns the legacy import.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	createRegistry,
	Harness,
	ProviderDoc,
	type Conversation,
	type EntryDraft,
	type EntryId,
	type EntryRecord,
	type RegistryReader,
	type Storage,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { PATHS } from "../../config.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { APP_IDENTITY, piModels } from "../agent/models.ts";

/** Entry kind of the bookkeeping input that starts a reaction run. It is
 *  hidden from the projection and dropped from every provider request
 *  (see the generation extension's beforeRequest hook). */
export const CONTINUATION_KIND = "lh.continuation";

/** The continuation input's content. Never model-visible; a readable
 *  sentinel so a dropped hook shows up as this line, not as silence. */
export const CONTINUATION_TEXT = "[continue]";

/** Every entry kind this app writes. Durable reserves the `pi.` prefix. */
export type LhEntryKind =
	| "lh.user"
	| "lh.assistant"
	| "lh.tool-result"
	| "lh.marker"
	| "lh.edit"
	| typeof CONTINUATION_KIND;

/** The `data` payload of an app-written entry. */
export interface LhEntryData {
	/** The record message id (client identity, coverage, provenance). */
	id?: string;
	/** The full record message, for custom-role markers (pi-ai's Message
	 *  union has no custom role, so the marker cannot live in `model`). */
	message?: LhMessage;
}

/** One open chat database: the Harness, its root conversation, and the
 *  per-chat append queue that keeps app writes ordered. */
export interface ChatRuntime {
	readonly chatId: string;
	readonly dir: string;
	readonly storage: Storage;
	readonly harness: Harness;
	readonly root: Conversation;
	/** Serializes app-originated entry appends (the old synchronous store's
	 *  ordering guarantee, now that every write is async). */
	queue: Promise<unknown>;
	closing: boolean;
}

/** Harness settings: the app's current behavior, not pi-durable's defaults.
 *  Provider retries are OFF — today a provider error rides its message
 *  verbatim to the banner, and silent re-spend is not a behavior change we
 *  are making. Steering drains everything handed over at one boundary (the
 *  app's old steeringMode "all"). */
function harnessSettings() {
	return {
		retry: { enabled: false },
		steeringMode: "all" as const,
		followUpMode: "all" as const,
	};
}

/** Per-chat registry factory. The server composition root installs the app
 *  extension (tools, prompt sections, hooks) here; a bare read-only open
 *  (tests, listing) runs with the built-in tasks only. */
let registryFactory: (chatId: string) => RegistryReader<ToolRegistration> = () => createRegistry();

export function setChatRegistryFactory(factory: (chatId: string) => RegistryReader<ToolRegistration>): void {
	registryFactory = factory;
}

/** Where a chat's runtime files live. */
export function durableDir(chatId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error(`Invalid chat id: ${chatId}`);
	return path.join(PATHS.data, "durable", chatId);
}

interface LhGlobal {
	__lhDurableRuntimes?: Map<string, RuntimeSlot>;
}

/** One slot per chat id: the runtime's lifecycle. The slot is the single
 *  owner of the database handle. It stays in the map through `closing` until
 *  the Harness has settled, so no second Harness can open on the same
 *  database while the first drains, and concurrent closes share one drain. */
type RuntimeSlot =
	| { readonly phase: "opening"; readonly opened: Promise<ChatRuntime> }
	| { readonly phase: "open"; readonly runtime: ChatRuntime }
	| { readonly phase: "closing"; readonly done: Promise<void> };

function slots(): Map<string, RuntimeSlot> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhDurableRuntimes ??= new Map());
}

async function openRuntime(chatId: string): Promise<ChatRuntime> {
	const dir = durableDir(chatId);
	fs.mkdirSync(dir, { recursive: true });
	const storage = await openNodeSqliteStorage(path.join(dir, "harness.sqlite"));
	let harness: Harness;
	try {
		harness = await Harness.open(
			storage,
			{
				models: () => piModels(),
				identity: APP_IDENTITY,
				registry: registryFactory(chatId),
				settings: () => harnessSettings(),
				onReport: (error, info) => {
					// A failed Session is the loud one; task faults are per-task noise.
					if (info.type === "session_failed") console.error(`[chat ${chatId}] durable session failed:`, error);
					else console.error(`[chat ${chatId}] durable ${info.type}:`, error);
				},
			},
			BACKGROUND_CONTEXT,
		);
	} catch (error) {
		await storage.close(BACKGROUND_CONTEXT).catch(() => undefined);
		throw error;
	}
	const root = await harness.root(BACKGROUND_CONTEXT, {
		init: async (tx, id) => {
			// Provider session affinity: the public chat id IS the provider
			// session id (the app has always sent it that way).
			(await tx.doc(ProviderDoc, id)).sessionId = chatId;
		},
	});
	return { chatId, dir, storage, harness, root, queue: Promise.resolve(), closing: false };
}

/** The chat's runtime, opening it on first use. One owner per database:
 *  callers share the in-flight open, and a chat that is closing refuses new
 *  work until its close settles (a fresh open is allowed afterwards). */
export async function openChatRuntime(chatId: string): Promise<ChatRuntime> {
	const map = slots();
	const slot = map.get(chatId);
	if (slot?.phase === "open") return slot.runtime;
	if (slot?.phase === "closing") throw new Error(`Chat ${chatId} is closing`);
	if (slot?.phase === "opening") {
		const runtime = await slot.opened;
		// The close that raced this open owns the slot now, and the runtime it
		// is draining is not open for business.
		if (map.get(chatId)?.phase === "closing") throw new Error(`Chat ${chatId} is closing`);
		return runtime;
	}
	const opening: RuntimeSlot = { phase: "opening", opened: openRuntime(chatId) };
	map.set(chatId, opening);
	try {
		const runtime = await opening.opened;
		if (map.get(chatId) === opening) map.set(chatId, { phase: "open", runtime });
		return runtime;
	} catch (error) {
		if (map.get(chatId) === opening) map.delete(chatId);
		throw error;
	}
}

/** A runtime that is already open, or undefined — for callers that must not
 *  pay an open (deletion teardown, tests). */
export function peekChatRuntime(chatId: string): Promise<ChatRuntime> | undefined {
	const slot = slots().get(chatId);
	if (slot?.phase === "open") return Promise.resolve(slot.runtime);
	if (slot?.phase === "opening") return slot.opened;
	return undefined;
}

/** Close the chat's Harness (settles admitted commits, closes storage) and
 *  release the slot. Idempotent: a concurrent close joins the first. New
 *  work is refused while closing. */
export async function closeChatRuntime(chatId: string): Promise<void> {
	const map = slots();
	const slot = map.get(chatId);
	if (!slot) return;
	if (slot.phase === "closing") return slot.done;
	const done = (async () => {
		const runtime = slot.phase === "opening" ? await slot.opened.catch(() => undefined) : slot.runtime;
		if (!runtime) return;
		runtime.closing = true;
		await runtime.queue.catch(() => undefined);
		await runtime.harness.close(BACKGROUND_CONTEXT).catch((error) => {
			console.error(`[chat ${chatId}] durable close failed:`, error);
		});
	})();
	map.set(chatId, { phase: "closing", done });
	try {
		await done;
	} finally {
		map.delete(chatId);
	}
}

/** Hard-delete the chat's durable directory (after the Harness is closed).
 *  Deletion is a real removal — no tombstone. */
export function removeChatRuntimeFiles(chatId: string): void {
	fs.rmSync(durableDir(chatId), { recursive: true, force: true });
}

// ─── the projection ──────────────────────────────────────────────────────────

const SCAN_PAGE = 256;

/** Every entry of the chat's root conversation, oldest first. */
export async function readEntries(runtime: ChatRuntime, context: Context = BACKGROUND_CONTEXT): Promise<EntryRecord[]> {
	const out: EntryRecord[] = [];
	let cursor: Record<string, unknown> | undefined;
	for (;;) {
		const page = await runtime.root.entries({ order: "ascending" }, SCAN_PAGE, cursor as never, context);
		out.push(...page.items);
		if (!page.next) return out;
		cursor = page.next as Record<string, unknown>;
	}
}

/** The app id of the messages an entry contributes. */
function messageId(entry: EntryRecord, index: number): string {
	const data = entry.data as LhEntryData | undefined;
	const base = data?.id ?? `e${entry.id}`;
	return index === 0 ? base : `${base}#${index}`;
}

/** Project entries into the app's record messages: every entry ascending,
 *  ContextEdits applied, bookkeeping inputs hidden. This is the ONE read
 *  projection — export, extraction, coverage, and the client all read it.
 *  `entryOf` maps each projected message id back to the entry that owns it
 *  (the ContextEdit target for a later update). */
export function projectTranscript(entries: readonly EntryRecord[]): {
	messages: LhMessage[];
	entryOf: Map<string, EntryId>;
} {
	// The newest edit per target wins (chained edits are legal; the last
	// writer's substitution is the one the model sees too). An entry that
	// carries edits contributes THROUGH its target, never on its own.
	const edits = new Map<EntryId, { entry: EntryRecord; replace?: readonly unknown[]; omit: boolean }>();
	const owners = new Set<EntryId>();
	for (const entry of entries) {
		for (const edit of entry.edits ?? []) {
			edits.set(edit.target, {
				entry,
				replace: edit.action === "replace" ? edit.messages : undefined,
				omit: edit.action === "omit",
			});
			owners.add(entry.id);
		}
	}
	const messages: LhMessage[] = [];
	const entryOf = new Map<string, EntryId>();
	const push = (message: unknown, entry: EntryRecord, index: number) => {
		const id = messageId(entry, index);
		messages.push({ ...(message as object), id } as LhMessage);
		entryOf.set(id, entry.id);
	};
	for (const entry of entries) {
		if (entry.kind === CONTINUATION_KIND) continue;
		if (owners.has(entry.id)) continue;
		const data = entry.data as LhEntryData | undefined;
		const edit = edits.get(entry.id);
		if (edit?.omit) continue;
		if (edit) {
			const ownerData = edit.entry.data as LhEntryData | undefined;
			if (ownerData?.message) {
				messages.push(ownerData.message);
				entryOf.set(ownerData.message.id, entry.id);
				continue;
			}
			(edit.replace ?? []).forEach((message, index) => push(message, edit.entry, index));
			continue;
		}
		if (data?.message) {
			messages.push(data.message);
			entryOf.set(data.message.id, entry.id);
			continue;
		}
		(entry.model ?? []).forEach((message, index) => push(message, entry, index));
	}
	return { messages, entryOf };
}

/** The app-message projection alone (see projectTranscript). */
export function projectEntries(entries: readonly EntryRecord[]): LhMessage[] {
	return projectTranscript(entries).messages;
}

/** The chat's full record transcript (the awaited read projection). */
export async function readChatMessages(chatId: string): Promise<LhMessage[]> {
	const runtime = await openChatRuntime(chatId);
	return projectEntries(await readEntries(runtime));
}

// ─── writes ──────────────────────────────────────────────────────────────────

/** UI-only markers carry no model face (the old convertToLlm filter, moved
 *  to write time: durable stores the model contribution). */
const UI_ONLY_MARKERS = new Set(["plan-block", "problem-dismissed"]);

/** The model-facing text of one record message, or null when it has none. */
export function modelTextOf(message: LhMessage): string | null {
	if (message.role !== "custom") return null;
	if (UI_ONLY_MARKERS.has(message.customType)) return null;
	return message.content;
}

/** The entry draft for one record message: pi-native messages ride `model`
 *  verbatim; markers keep their record shape in `data` and flatten to the
 *  single user message the provider saw before. */
export function draftForMessage(message: LhMessage): EntryDraft {
	if (message.role === "custom") {
		const text = modelTextOf(message);
		return {
			kind: "lh.marker",
			data: { message } as unknown as EntryDraft["data"],
			...(text === null || text === ""
				? {}
				: { model: [{ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: message.timestamp }] }),
		};
	}
	const { id, ...native } = message;
	return {
		kind: `lh.${native.role}`,
		data: { id },
		model: [native as never],
	};
}

/** Append record messages to the chat transcript, in order, in one commit.
 *  The caller has already decided they are new (see appendMessages). */
export async function appendEntries(chatId: string, drafts: readonly EntryDraft[]): Promise<void> {
	if (drafts.length === 0) return;
	const runtime = await openChatRuntime(chatId);
	if (runtime.closing) throw new Error(`Chat ${chatId} is closing`);
	const run = async () => {
		await runtime.harness.commit(async (tx) => {
			for (const draft of drafts) await tx.appendEntry(runtime.root.id, draft);
		}, BACKGROUND_CONTEXT);
	};
	const next = runtime.queue.then(run, run);
	runtime.queue = next.catch(() => undefined);
	await next;
}

/** Append the record messages the transcript does not hold yet, keyed by
 *  app message id; a message whose content changed is written as a
 *  ContextEdit over the entry that owns it (entries are immutable). The old
 *  store's saveMessages callers pass the WHOLE desired list, so this is its
 *  exact upsert contract. */
export async function appendMessages(chatId: string, messages: readonly LhMessage[]): Promise<void> {
	const runtime = await openChatRuntime(chatId);
	const { messages: current, entryOf } = projectTranscript(await readEntries(runtime));
	const byId = new Map(current.map((message) => [message.id, message]));
	const drafts: EntryDraft[] = [];
	for (const message of messages) {
		const target = entryOf.get(message.id);
		if (target === undefined) {
			drafts.push(draftForMessage(message));
			continue;
		}
		if (JSON.stringify(byId.get(message.id)) === JSON.stringify(message)) continue;
		drafts.push(editDraftFor(target, message));
	}
	await appendEntries(chatId, drafts);
}

/** The ContextEdit draft that rewrites one record message in place. */
export function editDraftFor(target: EntryId, message: LhMessage): EntryDraft {
	if (message.role === "custom") {
		const text = modelTextOf(message);
		return {
			kind: "lh.edit",
			data: { message } as unknown as EntryDraft["data"],
			edits: [
				{
					target,
					action: "replace",
					messages:
						text === null || text === ""
							? []
							: [{ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: message.timestamp }],
				},
			],
		};
	}
	const { id, ...native } = message;
	return {
		kind: "lh.edit",
		data: { id },
		edits: [{ target, action: "replace", messages: [native as never] }],
	};
}

/** Append one raw entry (a ContextEdit, an answer replacement, …). */
export async function appendEntry(chatId: string, draft: EntryDraft): Promise<void> {
	await appendEntries(chatId, [draft]);
}

/** The durable entry that holds a tool call's result (the ContextEdit
 *  target for a learner's answer). */
export async function findToolResultEntry(
	runtime: ChatRuntime,
	toolCallId: string,
): Promise<EntryRecord | undefined> {
	const entries = await readEntries(runtime);
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		const message = entry.model?.[0] as { role?: string; toolCallId?: string } | undefined;
		if (message?.role === "toolResult" && message.toolCallId === toolCallId) return entry;
	}
	return undefined;
}

/** Whether the chat's root conversation holds no entries yet (the legacy
 *  import's idempotency key). */
export async function isEmptyTranscript(runtime: ChatRuntime): Promise<boolean> {
	const page = await runtime.root.entries({}, 1, undefined, BACKGROUND_CONTEXT);
	return page.items.length === 0;
}
