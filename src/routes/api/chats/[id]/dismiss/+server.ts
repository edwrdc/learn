/**
 * THE SILENT DISMISSAL ROUTE (owner design): ESC-abort from a pending
 * question writes the dismissed toolResult to the record and wakes NOTHING —
 * no turn, no agent, no tokens. The session enters the derived dismissal
 * pause (endsInDismissal): job deliveries hold in the wake pipeline's steer
 * queue, and the user's next plain message is the wake that carries the
 * dismissal (plus any held deliveries) into the agent's context.
 *
 * Parallel question calls: each dismissal completes exactly its own call
 * (results bind by toolCallId, not position), so the dock advances
 * call-by-call and the composer returns only when nothing dangles.
 *
 * Guards: 404 unknown chat, 400 for an input that targets no dangling
 * question call (or isn't a real dismissal). A RUNNING turn does not refuse
 * (owner decision): the dismissal is PARKED (202) and the turn's settle path
 * applies it against the persisted record, so ESC-discard doubles as the
 * turn abort's bookkeeper (the client fires both).
 */
import { ChatInputError, parseDismissInput } from "@/src/session/model";
import { isTurnRunning, parkDismissal, requireChat, writeDismissal } from "@/src/session";
import { readJson } from "@/src/platform";
import type { RequestEvent } from "./$types";

export async function POST({ request: req, params }: RequestEvent): Promise<Response> {
	const { id } = params;
	const chat = await requireChat(id);
	if (chat instanceof Response) return chat;
	const json = await readJson(req);
	if (json instanceof Response) return json;

	let input;
	try {
		input = parseDismissInput((json.body as { input?: unknown } | null)?.input ?? null);
	} catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}

	// A running turn owns the chat's record — the dismissal cannot validate
	// against stale truth, so it is parked and applied at settle. The 202 is
	// the "noted, will land" contract.
	if (await isTurnRunning(id)) {
		parkDismissal(id, input);
		return Response.json({ ok: true, parked: true }, { status: 202 });
	}

	try {
		await writeDismissal(id, input);
	} catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
	return Response.json({ ok: true });
}
