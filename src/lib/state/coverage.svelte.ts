/** One chat's extraction coverage (from GET /api/chats/:id), loaded on first
 *  read in the browser and reloaded when the chat's turn settles or record
 *  changes, when any extraction run changes phase, and on SSE reconnect.
 *  Polled every 2s while an extraction of it runs (the events carry phase
 *  changes, not chunk progress). Shared by every view of the chat. */
import type { SessionCoverage } from "@/src/session/model";
import { fetchChat } from "$lib/api/chats";
import { serverEvents } from "./server-events";

class ChatCoverage {
	#value = $state.raw<SessionCoverage | null>(null);
	#started = false;
	#poll: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly chatId: string) {}

	get value(): SessionCoverage | null {
		this.#start();
		return this.#value;
	}

	refresh = async (): Promise<void> => {
		clearTimeout(this.#poll);
		try {
			this.#value = (await fetchChat(this.chatId)).coverage;
		} catch (error) {
			console.error(`[coverage ${this.chatId}] load failed:`, error);
		}
		if (this.#value?.running) this.#poll = setTimeout(() => void this.refresh(), 2000);
	};

	#start(): void {
		if (this.#started || typeof window === "undefined") return;
		this.#started = true;
		void this.refresh();
		const ownChat = ({ chatId }: { chatId: string }) => chatId === this.chatId && void this.refresh();
		serverEvents.subscribe("turn-settled", ownChat);
		serverEvents.subscribe("record-changed", ownChat);
		serverEvents.subscribe("activity-changed", () => void this.refresh());
		serverEvents.onResync(() => void this.refresh());
	}
}

const byChat = new Map<string, ChatCoverage>();

export function chatCoverage(chatId: string): ChatCoverage {
	let coverage = byChat.get(chatId);
	if (!coverage) byChat.set(chatId, (coverage = new ChatCoverage(chatId)));
	return coverage;
}
