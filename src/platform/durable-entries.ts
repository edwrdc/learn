import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";

/** Every entry of a durable conversation, oldest first. */
export async function readConversationEntries(conversation: Conversation, context: Context = BACKGROUND_CONTEXT): Promise<EntryRecord[]> {
	const out: EntryRecord[] = [];
	let cursor: Record<string, unknown> | undefined;
	for (;;) {
		const page = await conversation.entries({ order: "ascending" }, 256, cursor as never, context);
		out.push(...page.items);
		if (!page.next) return out;
		cursor = page.next as Record<string, unknown>;
	}
}
