/** The sidebar row's meta line: one fact, the most useful one. */
import type { ChatListItem } from "@/src/core";
import { timeAgo } from "$lib/format";

export function sessionMeta(chat: ChatListItem, now?: Date): string {
	if (chat.compacting) return `Compacting context · ${timeAgo(chat.updatedAt, now)}`;
	if (chat.pendingQuestion) return `Waiting for input · ${timeAgo(chat.updatedAt, now)}`;
	if ((chat.kind ?? "teach") === "practice" && chat.pendingProblem) return `Problem waiting · ${timeAgo(chat.updatedAt, now)}`;
	if (chat.busy) return "Working…";
	return timeAgo(chat.updatedAt, now);
}
