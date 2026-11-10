/** A chat view's reads of the server record: turns, the record's messages,
 *  the compaction flag and the chat's jobs. A job finishing while a turn
 *  streams adopts only appended messages and owes a full sync once the
 *  turn ends. */
import type { JobRecord } from "@/src/jobs/model";
import type { ChatSettings, ChatView, LhMessage, TurnUsage } from "@/src/session/model";
import { fetchChat, fetchJobs } from "$lib/api/chats";
import type { SessionView } from "./session.svelte";

export class ChatSync {
	turns = $state.raw<TurnUsage[]>([]);
	jobs = $state.raw<JobRecord[]>([]);
	compacting = $state(false);
	/** The chat's own model settings, from the last record read. */
	settings = $state.raw<ChatSettings | undefined>(undefined);
	#compactionRevision = 0;
	#owedSync = false;
	#jobStatuses = new Map<string, string>();
	#jobsDebounce: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly chatId: string,
		private readonly session: SessionView,
		private readonly view: {
			/** This view is streaming its own turn. */
			streaming: () => boolean;
			/** A full record landed (the view may owe a continuation). */
			onRecord: (messages: LhMessage[]) => void;
		},
		initiallyCompacting: boolean,
	) {
		this.compacting = initiallyCompacting;
	}

	/** The chat's record, or null after logging why it could not be read. */
	read = async (): Promise<ChatView | null> => {
		try {
			const record = await fetchChat(this.chatId);
			this.settings = record.settings;
			return record;
		} catch (error) {
			console.error(`[chat ${this.chatId}] record load failed:`, error);
			return null;
		}
	};

	syncTurns = async (): Promise<void> => {
		const record = await this.read();
		if (record?.turns) this.turns = record.turns;
	};

	syncRecord = async (): Promise<void> => {
		const record = await this.read();
		if (!record) return;
		if (record.turns) this.turns = record.turns;
		this.session.setMessages(record.messages);
		this.view.onRecord(record.messages);
	};

	/** Messages appended server-side while this view streams its own turn. */
	adoptAppended = async (): Promise<void> => {
		const record = await this.read();
		if (record) this.session.adoptRecord(record.messages);
	};

	syncCompaction = async (): Promise<void> => {
		const revision = ++this.#compactionRevision;
		const record = await this.read();
		// A pushed frame that arrived after the read started owns the state.
		if (!record || revision !== this.#compactionRevision) return;
		this.compacting = record.compacting;
	};

	setCompacting(running: boolean): void {
		this.#compactionRevision += 1;
		this.compacting = running;
	}

	syncJobs = async (): Promise<void> => {
		try {
			const data = await fetchJobs(this.chatId);
			const turnRunning = this.view.streaming() || data.turnInFlight;
			for (const job of data.jobs) {
				if (this.#jobStatuses.get(job.id) === "running" && job.status !== "running") {
					if (turnRunning) {
						this.#owedSync = true;
						void this.adoptAppended();
					} else {
						void this.syncRecord();
					}
				}
				this.#jobStatuses.set(job.id, job.status);
			}
			if (this.#owedSync && !turnRunning) {
				this.#owedSync = false;
				void this.syncRecord();
			}
			this.jobs = data.jobs;
		} catch (error) {
			console.error(`[chat ${this.chatId}] jobs load failed:`, error);
		}
	};

	scheduleJobs = (): void => {
		clearTimeout(this.#jobsDebounce);
		this.#jobsDebounce = setTimeout(() => void this.syncJobs(), 250);
	};

	dispose(): void {
		clearTimeout(this.#jobsDebounce);
	}
}
