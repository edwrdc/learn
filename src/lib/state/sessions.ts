import { renameChat } from "$lib/api/chats";

/** Rename a session and tell every open view (sidebar, graph labels, header). */
export async function renameSession(id: string, title: string): Promise<void> {
	await renameChat(id, title);
	window.dispatchEvent(new CustomEvent("lh:chat-renamed", { detail: { id, title } }));
}
