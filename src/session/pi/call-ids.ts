/**
 * TOOL-CALL ID UNIQUIFICATION: some providers (DeepSeek via OpenRouter, observed live) return
 * tool-call ids that reset every response — `call_0`, `call_1`, … — so a
 * one-call-per-turn session names EVERY call `call_0`. Everything in this
 * app keys on toolCallId (the view fold's call↔result join, the pending-
 * question gate, answer routing, the option-shuffle seed), so cross-turn
 * duplicates corrupted all of them at once: the fold applied the quiz
 * answer to the ASK card, the ask question vanished, the order scrambled.
 *
 * THE LAW: ids are uniquified ONCE, at the response boundary — the durable
 * afterResponse hook (durable-registry.ts) rewrites the message's calls
 * before classification. The client, the persisted record, the dock, the
 * answer flow, and the next turn's provider context (rebuilt from the
 * record) all see exactly one set of unique ids. Provider context stays
 * internally paired (call and result rewrite together), which the
 * OpenAI-compatible APIs accept — pi itself synthesizes ids for providers
 * that return none, so arbitrary-but-paired ids are already protocol-legal.
 * History is NEVER rewritten: record messages pass through untouched, and
 * older duplicate records heal at the fold (view.ts pairs results
 * newest-first).
 *
 * SCHEME: a per-chat seen-set (seeded from the record at turn start);
 * colliding ids become `${orig}~2`, `~3`, … skipping used ones.
 */

/** Structurally walk any message's content for tool-call blocks. */
function callBlocks(message: unknown): Array<{ id: string } & Record<string, unknown>> {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return [];
	return content.filter(
		(b): b is { id: string } & Record<string, unknown> =>
			(b as { type?: string } | null)?.type === "toolCall" && typeof (b as { id?: unknown }).id === "string",
	);
}

/** The ids every consumer may already have seen: all call ids and result
 *  ids in a message list (the chat record — including its legacy dupes,
 *  which is the point: membership is what drives minting). */
export function collectToolCallIds(messages: readonly unknown[]): string[] {
	const ids: string[] = [];
	for (const m of messages) {
		const role = (m as { role?: string }).role;
		if (role === "assistant") {
			for (const b of callBlocks(m)) ids.push(b.id);
		} else if (role === "toolResult") {
			const id = (m as { toolCallId?: unknown }).toolCallId;
			if (typeof id === "string") ids.push(id);
		}
	}
	return ids;
}

/** Claim one tool-call id: keep it when unused, otherwise mint `${orig}~n`
 *  and record the claim. */
export function claimToolCallId(orig: string, seen: Set<string>): string {
	if (!seen.has(orig)) {
		seen.add(orig);
		return orig;
	}
	for (let n = 2; ; n++) {
		const candidate = `${orig}~${n}`;
		if (!seen.has(candidate)) {
			seen.add(candidate);
			return candidate;
		}
	}
}
