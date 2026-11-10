import type { LhMessage } from "./transcript.ts";
import type { ChatRecord, ChatSettings, ChatSummary, ExtractionRunUsage, TurnUsage } from "./types.ts";
import type { PlanTree } from "./plan-types.ts";

// ─── ChatStore — the session record's home (data/chats) ─────────────────────

export interface ChatStore {
	/** Create a session record (persisted immediately). */
	/** Create a session record; kind "practice" marks a practice session
	 *  (absent = teach, the default). */
	createChat(title: string, kind?: "practice"): ChatRecord;
	/** The full record, or null if unknown id / corrupt file. AWAITED: the
	 * transcript is a read projection over the durable entries (see
	 * src/store/durable.ts), never a second in-memory authority. */
	getChat(id: string): Promise<ChatRecord | null>;
	/** Several records, in order (null for an unknown id). Opens at most
	 *  three chat runtimes at a time; rejects when a read rejects. */
	getChats(ids: string[]): Promise<(ChatRecord | null)[]>;
	/** All sessions, newest activity first (the sidebar's list view). */
	listChats(): Promise<ChatSummary[]>;
	/** Upsert supplied native messages by id. Omitted messages remain;
	 * callers can append without replaying a transcript snapshot. */
	saveMessages(id: string, messages: LhMessage[]): Promise<void>;
	/** Bump the record's activity timestamp after an ACCEPTED transcript
	 *  write (turn, answer, dismissal). Settings, renames and tree edits
	 *  deliberately do not call it. */
	touchChat(id: string): Promise<void>;
	/** Persist the session plan tree (plan tools call this in execute). */
	saveTree(id: string, tree: PlanTree): Promise<void>;
	/** Append one usage entry to the record's turn log (the money channel,
	 * 2026-09): idempotent per turn id — each request carries its own, so
	 * a turn persisted twice appends once while continuation turns (which
	 * share a response message id) each keep their usage. */
	appendTurnUsage(id: string, entry: TurnUsage): Promise<void>;
	/** Append one extraction-run usage entry — idempotent per startedAt. */
	appendExtractionUsage(id: string, entry: ExtractionRunUsage): Promise<void>;
	/** Persist the per-chat model/thinking settings (the model control).
	 *  Replace-whole: the picker sends the complete settings object. */
	saveSettings(id: string, settings: ChatSettings): Promise<void>;
	/** Rename a session (the header's click-to-edit title, 2026-09-17).
	 * Like saveSettings: a rename is NOT conversation activity — updatedAt
	 * stays put, so sidebar order never churns on a rename. */
	renameChat(id: string, title: string): Promise<ChatRecord>;
	/** Delete the session record entirely (session-deletion wave 6, owner
	 *  2026-09-22). False when the id is unknown; removal failures throw.
	 *  The graph-ledger purge and job cleanup are the caller's choreography
	 *  (core/graph-deletion.ts + the DELETE route), not the store's. */
	deleteChat(id: string): Promise<boolean>;
}
