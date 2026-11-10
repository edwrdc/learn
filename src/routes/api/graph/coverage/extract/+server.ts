/**
 * POST /api/graph/coverage/extract — the manual extraction affordance: run
 * the pipeline over ONE session's uncovered content, whatever its size — the
 * user's answer to an aborted run, a pipeline error, or a session that went
 * dormant under the chunk budget. The pipeline batches under the
 * graph.extractionChunkTokens setting and checkpoints coverage per merged
 * batch, so this is the same run the trigger fires, just user-initiated.
 * 409 while a run is already in flight; failures are logged by the
 * pipeline and leave coverage untouched.
 */
import { services } from "@/src/boot";
import { readJson } from "@/src/platform";
import { requireChat } from "@/src/session";
import type { RequestEvent } from "./$types";

export async function POST({ request }: RequestEvent) {
	const json = await readJson(request);
	if (json instanceof Response) return json;
	const chatId = (json.body as { chatId?: unknown } | null)?.chatId;
	if (typeof chatId !== "string" || chatId === "") {
		return Response.json({ error: 'Body must be {chatId: string}' }, { status: 400 });
	}
	const chat = await requireChat(chatId);
	if (chat instanceof Response) return chat;
	const refusal = services().extraction.refusal();
	if (refusal) return Response.json(refusal, { status: 503 });
	if (services().extraction.isRunning(chatId)) {
		return Response.json({ error: "An extraction run is already in flight for this session" }, { status: 409 });
	}
	// Fire-and-forget, like the trigger: the dock + the coverage panel's
	// running flags track progress.
	void services().extraction.runExtraction(chatId).catch((err: unknown) => {
		console.error(`[chat ${chatId}] manual extraction failed:`, err);
	});
	return Response.json({ started: true }, { status: 202 });
}