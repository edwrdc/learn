import { setArtifactInverted } from "../api/chats.ts";

/** Persist an artifact card's invert switch. The card owns the local toggle,
 *  so a failed write costs only the persisted preference, never the render. */
export function persistInverted(chatId: string | undefined, messageId: string | undefined, inverted: boolean): void {
	if (!chatId || !messageId) return;
	setArtifactInverted(chatId, messageId, inverted).catch((error) => console.error("[artifact-ui] invert not saved:", error));
}
