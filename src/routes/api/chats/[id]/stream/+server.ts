/**
 * THE turn wire: POST /api/chat acknowledges and closes, so the submitter
 * too attaches here. One SSE stream per chat: a running turn → FULL replay of
 * the event log, then live chunks until settle ([DONE]). No running turn →
 * the cheap terminal ({"type":"turn-settled"} + [DONE]): the record is
 * current, the client refetches it. 404 unknown chat.
 */
import { requireChat, runningTurn, piTurnResponse, settledTurnResponse } from "@/src/session";
import type { RequestEvent } from "./$types";

export async function GET({ params }: RequestEvent): Promise<Response> {
	const { id } = params;
	const chat = await requireChat(id);
	if (chat instanceof Response) return chat;
	const handle = runningTurn(id);
	if (!handle) return settledTurnResponse();
	return piTurnResponse(handle);
}
