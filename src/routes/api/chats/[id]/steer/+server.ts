// POST /api/chats/[id]/steer — the composer's mid-turn steering rail. The
// learner's message for a RUNNING turn becomes a durable inbox input, read
// at the run's next boundary and kept by the record; the client upserts the
// card by the client-minted id.
//
// This is steering, NOT follow-ups: the route never starts a turn and
// never extends an ended one. No live turn → 409 and the client falls
// back to a plain text send (the settle race).
import { ChatInputError, newUserSteer, parseUserSteerInput } from "@/src/session/model";
import { requireChat } from "@/src/session";
import { readJson } from "@/src/platform";
import { steerLiveChat } from "@/src/jobs";
import type { RequestEvent } from "./$types";

export async function POST({ request, params }: RequestEvent): Promise<Response> {
	const { id } = params;
	const chat = await requireChat(id);
	if (chat instanceof Response) return chat;
	const json = await readJson(request);
	if (json instanceof Response) return json;
	let input;
	try {
		input = parseUserSteerInput((json.body as { input?: unknown } | null)?.input);
	} catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
	const message = newUserSteer(input.text, input.id);
	if (!(await steerLiveChat(id, message))) {
		return Response.json({ error: "no live turn to steer" }, { status: 409 });
	}
	return Response.json({ ok: true });
}
