import { renameChat } from "$lib/api/chats";
import { emitAppEvent } from "$lib/events";

/** Rename a session and tell every open view (sidebar, graph labels, header). */
export async function renameSession(id: string, title: string): Promise<void> {
	await renameChat(id, title);
	emitAppEvent("chat-renamed", { id, title });
}
