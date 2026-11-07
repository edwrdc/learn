import { abortExtraction, extractionStatuses } from "../agent/subagents/extraction.ts";
import { coverageOf } from "../core/coverage.ts";
import { deleteChatTraces, type ChatDeleteMode, type ChatDeletionStats } from "../core/graph-deletion.ts";
import { titleFromPrompt, type SessionCoverage } from "../core/contracts.ts";
import { graphRevision } from "./graph.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { withChatOperation } from "./chat-operations.ts";

/**
 * Server-side chat entries for the transport layer (app/api/chats*,
 * app/chat/[id]). Today these delegate straight to the ChatStore port; the
 * services stage carves the real orchestration behind this same surface.
 *
 * deleteChatSession (wave 6, session deletion — the FIRST destructive
 * operation on the graph ledgers) is the one real orchestration here:
 * gates → extraction wind-down → ledger purge → awaited storage deletion. See
 * core/graph-deletion.ts for the ledger semantics and the atomicity
 * argument.
 */

export const { createChat, getChat, listChats } = stores.chatStore;
export { titleFromPrompt };
export type { ChatDeleteMode, ChatDeletionStats } from "../core/graph-deletion.ts";

/** How long the wind-down wait may take before the caller gets a retryable
 *  503 (an aborted extraction ends at its next model-call boundary —
 *  provider cancellation is normally sub-second, but a wedged provider
 *  must never wedge deletion). */
const WIND_DOWN_TIMEOUT_MS = 10_000;
const WIND_DOWN_POLL_MS = 50;

/** What deleteChatSession did — the route maps it straight to HTTP. */
export type ChatDeleteOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 409; code: "turn_in_flight" | "jobs_running"; error: string; jobIds: string[] }
	| { ok: false; status: 500; code: "delete_failed"; error: string }
	| { ok: false; status: 503; code: "extraction_winding_down"; error: string }
	| {
			ok: true;
			mode: ChatDeleteMode;
			stats: ChatDeletionStats;
			jobsRemoved: number;
			graphRevision: number;
	  };

/**
 * Delete a session (owner rulings 2026-09-22/23): gates first, then the
 * purge. The owner-locked choreography:
 *
 *   1. GATES — a turn in flight or a running background job refuses with
 *      409 (they write the chat record and steer into it; deleting
 *      mid-flight would corrupt the write-ahead flow). The UI retries once
 *      work drains.
 *   2. EXTRACTION WIND-DOWN — the chat's own pipeline run is TRUE-
 *      CANCELLED (abortExtraction: spend stops, nothing merges), then
 *      awaited off the registry. A timeout is a retryable 503, never a
 *      forced race.
 *   3. PURGE — ledger and job rewrites are synchronous, then storage
 *      deletion awaits runtime close. Ledgers first, chat record last keeps a
 *      partially purged chat available for a retry after a crash.
 *
 * The first read can recover an interrupted turn, which then refuses deletion.
 */
export async function deleteChatSession(chatId: string, mode: ChatDeleteMode): Promise<ChatDeleteOutcome> {
	return withChatOperation(chatId, async () => {
		if (!(await stores.chatStore.getChat(chatId))) {
			return { ok: false, status: 404, code: "not_found", error: "No such session" };
		}
		if (await isTurnRunning(chatId)) {
			return {
				ok: false,
				status: 409,
				code: "turn_in_flight",
				error: "A turn is running in this session — try again when it finishes",
				jobIds: [],
			};
		}
		const runningJobs = stores.jobStore.listJobs(chatId).filter((job) => job.status === "running");
		if (runningJobs.length > 0) {
			return {
				ok: false,
				status: 409,
				code: "jobs_running",
				error: "Background jobs are still running in this session — try again when they finish",
				jobIds: runningJobs.map((job) => job.id),
			};
		}
		if (extractionStatuses().some((run) => run.chatId === chatId)) {
			abortExtraction(chatId); // true cancellation — spend stops, nothing merges
			const deadline = Date.now() + WIND_DOWN_TIMEOUT_MS;
			while (extractionStatuses().some((run) => run.chatId === chatId)) {
				if (Date.now() > deadline) {
					return {
						ok: false,
						status: 503,
						code: "extraction_winding_down",
						error: "The session's extraction is still winding down — try again in a moment",
					};
				}
				await new Promise((resolve) => setTimeout(resolve, WIND_DOWN_POLL_MS));
			}
		}

		const stats = deleteChatTraces(stores.graphStore, chatId, mode);
		const jobsRemoved = stores.jobStore.deleteJobsForChat(chatId);
		try {
			if (!(await stores.chatStore.deleteChat(chatId))) throw new Error("Session storage did not delete the chat");
		} catch (error) {
			console.error(`[chat ${chatId}] session deletion failed:`, error);
			return { ok: false, status: 500, code: "delete_failed", error: "Session deletion failed. Try again." };
		}
		return { ok: true, mode, stats, jobsRemoved, graphRevision: graphRevision() };
	});
}


/** The per-session coverage block (see SessionCoverage). Null when the
 *  chat doesn't exist — callers own the 404. */
export async function sessionCoverage(chatId: string): Promise<SessionCoverage | null> {
	const record = await stores.chatStore.getChat(chatId);
	if (!record) return null;
	const entries = stores.graphStore.readCoverage();
	// Wave B: the record is native history — coverage reads through the
	// projection (same view the extraction pipeline folds).
	const cov = coverageOf(record.messages, entries, chatId);
	let lastFoldedAt: string | null = null;
	for (const entry of entries) {
		if (entry.chatId !== chatId) continue;
		if (lastFoldedAt === null || entry.foldedAt > lastFoldedAt) lastFoldedAt = entry.foldedAt;
	}
	return {
		totalMessages: cov.slots.length,
		coveredCount: cov.coveredCount,
		uncoveredCount: cov.uncoveredCount,
		coveredTokens: cov.coveredTokens,
		uncoveredTokens: cov.uncoveredTokens,
		running: extractionStatuses().some((run) => run.kind === "chat" && run.chatId === chatId),
		lastFoldedAt,
	};
}
