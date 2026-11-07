/** Persist an artifact card's invert switch (POST /api/chats/:id/artifact-ui).
 *  The card owns the local toggle, so this is fire-and-forget: a failed write
 *  only costs the persisted preference, never the render. */
export function persistInverted(chatId: string | undefined, messageId: string | undefined, inverted: boolean): void {
	if (!chatId || !messageId) return;
	void fetch(`/api/chats/${chatId}/artifact-ui`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ input: { messageId, inverted } }),
	}).catch(() => {});
}
