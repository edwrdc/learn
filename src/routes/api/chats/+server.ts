import { parseNewChat } from "@/src/session/model";
import { compactionInFlight, isTurnRunning, listChats, startChat } from "@/src/session";
import { readJson } from "@/src/platform";
import type { ChatListItem } from "@/src/session/model";
import type { RequestEvent } from "./$types";

/** The session picker's list: record-derived summaries (phase, pending
 *  question) + liveness — the store can't see liveness, the route is the
 *  merge point. Owner decision: background jobs do NOT count — the
 *  sidebar's Background agents section is their channel (a running spinner
 *  per row would double-signal them), so busy means exactly "a teach turn
 *  is in flight". */
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
