/**
 * THE ARTIFACT-UI ROUTE (owner, 2026-10-07): persists the learner's invert
 * switch onto a demo/figure steer message (details.ui.inverted) so it
 * survives session navigation and restarts. Modeled on the dismissal
 * route's SILENCE: no wake, no agent, no tokens, no SSE — the record is
 * the only state that moves, and the client already holds the toggled
 * state optimistically (no refetch churn).
 *
 * Guards: 404 unknown chat, 400 for a body that isn't
 * { input: { messageId, inverted } } or targets no demo/visual steer.
 */
import { setSteerUiInverted } from "@/src/jobs/model";
import { chatStore, requireChat } from "@/src/session";
import { readJson } from "@/src/platform";
import type { RequestEvent } from "./$types";

export async function POST({ request: req, params }: RequestEvent): Promise<Response> {
	const { id } = params;
	const chat = await requireChat(id);
	if (chat instanceof Response) return chat;
	const json = await readJson(req);
	if (json instanceof Response) return json;
	const input = (json.body as { input?: unknown } | null)?.input as { messageId?: unknown; inverted?: unknown } | null | undefined;
	if (
		!input ||
		typeof input !== "object" ||
		typeof input.messageId !== "string" ||
		typeof input.inverted !== "boolean"
	) {
		return Response.json({ error: "input must be { messageId: string, inverted: boolean }" }, { status: 400 });
	}

	const changed = setSteerUiInverted(chat.messages, input.messageId, input.inverted);
	if (!changed) return Response.json({ error: "No demo/figure steer with that message id" }, { status: 400 });
	await chatStore.saveMessages(id, [changed]);
	return Response.json({ ok: true });
}
