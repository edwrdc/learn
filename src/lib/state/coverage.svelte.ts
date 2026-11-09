/** One chat's extraction coverage (from GET /api/chats/:id), polled every 2s
 *  while an extraction of it runs. Shared by every view of the chat. */
import type { SessionCoverage } from "@/src/session/model";
import { fetchChat } from "$lib/api/chats";

class ChatCoverage {
	value = $state.raw<SessionCoverage | null>(null);
	#poll: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly chatId: string) {}

	refresh = async (): Promise<void> => {
		clearTimeout(this.#poll);
		try {
			this.value = (await fetchChat(this.chatId)).coverage;
		} catch (error) {
			console.error(`[coverage ${this.chatId}] load failed:`, error);
		}
		if (this.value?.running) this.#poll = setTimeout(() => void this.refresh(), 2000);
	};
}

const byChat = new Map<string, ChatCoverage>();

export function chatCoverage(chatId: string): ChatCoverage {
	let coverage = byChat.get(chatId);
	if (!coverage) byChat.set(chatId, (coverage = new ChatCoverage(chatId)));
	return coverage;
}
