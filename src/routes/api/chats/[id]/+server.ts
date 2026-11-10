import { chatStore, compactionInFlight, deleteChatSession, isTurnRunning, requireChat, sessionCoverage } from "@/src/session";
import { readJson } from "@/src/platform";
import { type ChatDeleteMode } from "@/src/graph/model";
import type { ChatView } from "@/src/session/model";
import type { RequestEvent } from "./$types";

export async function GET({ params }: RequestEvent) {
	const { id } = params;
	const chat = await requireChat(id);
	if (chat instanceof Response) return chat;
	// The record's messages are native agent history, served VERBATIM — the
	// client derives its view. turnInFlight lets a returning client
	// re-attach to a running turn; coverage is the chat view's ring meter.
	const [turnInFlight, coverage] = await Promise.all([isTurnRunning(id), sessionCoverage(id)]);
	const view: ChatView = { ...chat, turnInFlight, compacting: compactionInFlight(id), coverage };
	return Response.json(view);
}

/**
 * Rename: the header's click-to-edit title commits here.
 * Validation is a single rule — a non-empty string after trim (the store's
 * "Untitled session" floor is never reached from this route). updatedAt is
 * deliberately NOT bumped: a rename must not reorder the sidebar (same
 * rule as the settings PUT).
 */
export async function PUT({ request: req, params }: RequestEvent) {
	const { id } = params;
	const chat = await requireChat(id);
	if (chat instanceof Response) return chat;
	const json = await readJson(req);
	if (json instanceof Response) return json;
	const title = (json.body as { title?: unknown } | null)?.title;
	if (typeof title !== "string" || title.trim() === "") {
		return Response.json({ error: "title must be a non-empty string" }, { status: 400 });
	}
	const record = await chatStore.renameChat(id, title.trim());
	return Response.json({ title: record.title });
}

/**
 * DELETE /api/chats/[id]?mode=preserve-graph|delete-nodes — session deletion
 * (owner decision). The mode is REQUIRED and explicit:
 * no default, because the two differ in destructiveness —
 *
 *   preserve-graph  the session record, its jobs, and its extraction
 *                   bookkeeping (coverage/checkpoint rows) die; the graph
 *                   keeps every contribution the session merged.
 *   delete-nodes    "this session never happened": every ledger trace of
 *                   the session goes too — provenance, link lines,
 *                   events, mappings — and orphaned nodes die entirely
 *                   (shared nodes survive automatically, their other
 *                   sessions' content intact).
 *
 * Gates are deleteChatSession's: 409 while a turn or background job is
 * running, 503 while the session's extraction is winding down after its
 * abort — both retryable. The
 * response carries what was removed plus the new graphRevision (the
 * version stamp the UI polls to refetch clusters/layout).
 */
export async function DELETE({ request: req, params }: RequestEvent) {
	const { id } = params;
	const mode = new URL(req.url).searchParams.get("mode");
	if (mode !== "preserve-graph" && mode !== "delete-nodes") {
		return Response.json(
			{
				error: 'mode is required and must be "preserve-graph" or "delete-nodes"',
				code: "bad_mode",
			},
			{ status: 400 },
		);
	}
	const outcome = await deleteChatSession(id, mode as ChatDeleteMode);
	if (!outcome.ok) {
		return Response.json(
			{
				error: outcome.error,
				code: outcome.code,
				...("jobIds" in outcome ? { jobIds: outcome.jobIds } : {}),
		},
			{ status: outcome.status },
		);
	}
	return Response.json({
		ok: true,
		mode: outcome.mode,
		stats: outcome.stats,
		jobsRemoved: outcome.jobsRemoved,
		graphRevision: outcome.graphRevision,
	});
}
