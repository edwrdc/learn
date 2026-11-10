import { isTurnRunning, requireChat } from "@/src/session";
import { jobStore } from "@/src/jobs";
import type { RequestEvent } from "./$types";

/**
 * Job status endpoint (contracts.ts "THE ASYNC PROTOCOL" §4): the chat
 * view's jobs fetch lands here — once on mount, per jobs-changed
 * announcement (the store emits post-write, debounced client-side), and
 * on channel resync (push-architecture S4, 2026-10-02 — the old interval
 * poll is retired). It drives the dispatch cards, the sub-agents panel,
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
