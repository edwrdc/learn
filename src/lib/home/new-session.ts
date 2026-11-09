import type { GraphContextPick } from "@/src/session/model";
import { createChat } from "../api/chats.ts";

/** Create-on-send for the sessionless draft: nothing exists until the first
 *  message; that message becomes the title (and the prompt rides the URL). */
export async function startDraftSession(
	value: string,
	mode: "teach" | "practice" = "teach",
	picks: readonly GraphContextPick[] = [],
	title = value.trim(),
): Promise<string | null> {
	const prompt = value.trim();
	if (!title || !prompt) return null;
	const { id } = await createChat(
		mode === "practice"
			? { title, kind: "practice", ...(picks.length > 0 ? { graphContext: { propositions: [...picks] } } : {}) }
			: { title },
	);
	return `/chat/${encodeURIComponent(id)}?prompt=${encodeURIComponent(prompt)}`;
}
