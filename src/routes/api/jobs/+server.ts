import { isTurnRunning, requireChat } from "@/src/session";
import { jobStore } from "@/src/jobs";
import type { RequestEvent } from "./$types";

/**
 * The chat view's jobs fetch — once on mount, per jobs-changed announcement,
 * and on channel resync. It drives the dispatch cards, the sub-agents panel,
 * and the re-sync when a job settles. `turnInFlight` rides along for the
 * settle logic's idle check.
 */
export async function GET({ url }: RequestEvent) {
	const chatId = url.searchParams.get("chatId");
	if (!chatId) {
		return Response.json({ error: "chatId query parameter is required" }, { status: 400 });
	}
	const chat = await requireChat(chatId);
	if (chat instanceof Response) return chat;
	return Response.json({ jobs: jobStore.listJobs(chatId), turnInFlight: await isTurnRunning(chatId) });
}
