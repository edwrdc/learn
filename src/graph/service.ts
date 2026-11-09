import * as fs from "node:fs";
import { GRAPH_FORMAT_FILE, LEDGER_FILES, POSITIONS_FILE, SOURCES_FILE } from "../platform/index.ts";
import type { ChatRecord } from "../session/model/index.ts";
import type { GraphSnapshot } from "./model/types.ts";
import type { GraphCostSummary } from "../session/model/index.ts";
import { graphCostSummary } from "../session/model/index.ts";
import { graphSnapshot } from "./snapshot.ts";
import { birthSessionPartition } from "./model/session-clusters.ts";
import {
	deleteNodeTraces,
	type NodeDeletionStats,
} from "./model/deletion.ts";
import { extractionStatuses } from "./extraction/pipeline.ts";
import { stores } from "../stores.ts";

/**
 * Server-side graph entry for the home view (GET /api/graph). A PURE READ:
 * the extraction pipeline (the sole graph writer) is triggered by quiz
 * answers in sessions (turn-service), never from here — the home view
 * reflects whatever the pipeline has merged so far.
 */
export async function graphView(): Promise<GraphSnapshot> {
	return graphSnapshot(stores);
}

/** The graph view's cost surface (GET /api/graph/costs — the 2026-09 cost
 *  pill): fold every usage channel into stage totals + recent runs. A pure
 *  read over the chat records (chat-front-door runs), the notes sources
 *  (notes-front-door runs), and the naming ledger (graph-global runs);
 *  dollars are inferred by the pure core fold (core/cost-summary.ts +
 *  prices.ts) — nothing here stores or caches money. */
export async function graphCosts(): Promise<GraphCostSummary> {
	const summaries = await stores.chatStore.listChats();
	const chats: Array<{ title: string; extractions: NonNullable<ChatRecord["extractions"]> }> = [];
	for (let i = 0; i < summaries.length; i += 3) {
		const batch = summaries.slice(i, i + 3);
		const records = await Promise.all(batch.map((summary) => stores.chatStore.getChat(summary.id)));
		batch.forEach((summary, index) => {
			const record = records[index];
			if (record?.extractions?.length) chats.push({ title: record.title ?? summary.id, extractions: record.extractions });
		});
	}
	const sources = stores.graphStore
		.readSources()
		.filter((s) => s.extractions?.length)
		.map((s) => ({ filePath: s.filePath, extractions: s.extractions! }));
	return graphCostSummary({ chats, sources });
}

/** The graph's version stamp (session-deletion wave 6): the max mtime
 * across every graph data file — ledgers, positions. Moves on ANY
 * graph write (merge append, settle, or a deletion's atomic rewrite),
 * never moves on reads, and needs no bookkeeping of its own: the fs
 * IS the counter. Consumers poll it (the activity feed
 *  carries it; the DELETE response returns it) to know clusters/layout
 *  must refetch — the "graph changed underneath me" signal. */
export function graphRevision(): number {
	let revision = 0;
	for (const file of [...Object.values(LEDGER_FILES), SOURCES_FILE, POSITIONS_FILE, GRAPH_FORMAT_FILE]) {
		try {
			revision = Math.max(revision, fs.statSync(file).mtimeMs);
		} catch {
			/* absent — nothing has ever written it */
		}
	}
	return revision;
}

// ─── single-node deletion (node interlude, owner-locked full-death) ──────────

/** What deleteGraphNode did — the route maps it straight to HTTP. */
type NodeDeleteOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 409; code: "extraction_running"; error: string }
	| { ok: true; stats: NodeDeletionStats; graphRevision: number };

/**
 * Delete one node by id — FULL DEATH (core/graph-deletion.ts for the
 * ledger semantics). The guard family is deliberately NOT the chat
 * one, and the reasoning is worth writing down:
 *
 *   - No turn/jobs gates. Turns and background jobs never write the
 *     graph ledgers; a turn's follow-up extraction registers as a run,
 *     and every code path here is synchronous — nothing can register
 *     or merge between the gate and the ledger rewrite (the event loop
 *     never yields inside this function).
 *   - THE EXTRACTION GATE — 409 while ANY pipeline run is registered,
 *     anywhere. A mid-flight run holds findings extracted from
 *     transcripts that predate the deletion; its merges could re-add
 *     aliases, provenance, or events to the dying node (the
 *     re-reference risk the dispatch flags). Unlike chat deletion we
 *     do NOT abort the run: it belongs to some session, and killing
 *     that session's spend is outside this deletion's blast radius —
 *     the UI retries once the dock drains. A run that starts AFTER
 *     the deletion is legitimate re-learning: it reads post-deletion
 *     ledgers, mints a fresh node for a re-taught topic, and
 *     mergeFindings ignores linkTo ids that no longer exist (the
 *     existingIds guard) — no dangling edges, no resurrection.
 */
export function deleteGraphNode(nodeId: string): NodeDeleteOutcome {
	if (extractionStatuses().length > 0) {
		return {
			ok: false,
			status: 409,
			code: "extraction_running",
			error: "An extraction is running — try again when it finishes",
		};
	}
	// THE SYNC BLOCK — no awaits below (the doc above): the gate and the
	// rewrite are one atomic stretch of the event loop.
	const stats = deleteNodeTraces(stores.graphStore, nodeId);
	if (stats === null) {
		return { ok: false, status: 404, code: "not_found", error: "No such node" };
	}
	return { ok: true, stats, graphRevision: graphRevision() };
}

