/** Create-on-send for the sessionless draft: nothing exists until the first
 *  message; that message becomes the title (and the prompt rides the URL). */
export interface PracticePick { id: string; name: string; statement: string }

export async function startDraftSession(
	value: string,
	fetchImpl: typeof fetch = fetch,
	mode: "teach" | "practice" = "teach",
	picks: readonly PracticePick[] = [],
	title = value.trim(),
): Promise<string | null> {
	const prompt = value.trim();
	if (!title || !prompt) return null;
	const res = await fetchImpl("/api/chats", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(
			mode === "practice"
				? { title, kind: "practice", ...(picks.length > 0 ? { graphContext: { propositions: picks } } : {}) }
				: { title },
		),
	});
	const { id } = (await res.json()) as { id: string };
	return `/chat/${id}?prompt=${encodeURIComponent(prompt)}`;
}
