import { renameChat } from "$lib/api/chats";
import { emitAppEvent } from "$lib/events";

/** Rename a session and tell every open view (sidebar, graph labels,
 *  header). The draft is trimmed; an empty or unchanged title saves
 *  nothing. */
export async function renameSession(id: string, draft: string, current: string): Promise<void> {
	const title = draft.trim();
	if (!title || title === current) return;
	await renameChat(id, title);
	emitAppEvent("chat-renamed", { id, title });
}
