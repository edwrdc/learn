import { parseNewChat } from "@/src/session/model";
import { compactionInFlight, isTurnRunning, listChats, startChat } from "@/src/session";
import { readJson } from "@/src/platform";
import type { ChatListItem } from "@/src/session/model";
import type { RequestEvent } from "./$types";

/** The session picker's list: record-derived summaries (phase, pending
 *  question) + live liveness — a running turn marks the session busy
 *  (contracts.ts ChatListItem; the store can't see liveness, the route is
 *  the merge point). Owner, minimal-color round: background jobs NO LONGER
 *  count — the sidebar's Background agents section is their channel now
 *  (a running spinner per row would double-signal them), so busy means
 *  exactly "a teach turn is in flight". */
export async function GET() {
	const chats: ChatListItem[] = await Promise.all(
		(await listChats()).map(async (c) => ({
			...c,
			busy: await isTurnRunning(c.id),
			compacting: compactionInFlight(c.id),
		})),
	);
	return Response.json({ chats });
}

export async function POST({ request: req }: RequestEvent) {
	const json = await readJson(req);
	if (json instanceof Response) return json;
	return Response.json(await startChat(parseNewChat(json.body)));
}
