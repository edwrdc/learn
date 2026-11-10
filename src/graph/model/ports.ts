import type { ExtractionRunUsage } from "../../session/model/index.ts";
import type { GraphChain, GraphNode, Position, CoverageEntry, SessionCheckpoint, NotesSource } from "./types.ts";

// ─── GraphStore — the append-only evidence ledgers (data/graph) ──────────────
// Chains are the stored truth: nodes + reasoning chains; edges are a
// DERIVED view (snapshot.ts) and never touch this seam. Reads return the
// raw append-order lines; merging chain assertions by (premises,
// conclusion) is DERIVED in snapshot.ts — the store never decides. The
// extraction pipeline is the sole writer.

export interface GraphStore {
	/** Append one GraphNode line (a repeated id is a link-append; readers
	 *  merge by id). */
	appendNode(node: GraphNode): void;
	/** Raw node lines in append order. */
	readNodes(): GraphNode[];

	/** Append one chain ASSERTION (a second session asserting the same
	 *  (premises, conclusion) appends another line; readers merge). */
	appendChain(assertion: GraphChain): void;
	readChains(): GraphChain[];

	/** Append one emission checkpoint. */
	appendCheckpoint(checkpoint: SessionCheckpoint): void;
	readCheckpoints(): SessionCheckpoint[];
	/** Message-granular extraction coverage: append-only; one line per covered message. The chat-extraction
	 *  checkpoint — "uncovered" is derived from these, never tracked. */
	appendCoverage(entry: CoverageEntry): void;
	readCoverage(): CoverageEntry[];

	/** Upsert one imported-notes source record (SOURCES_FILE — a
	 *  JSON map, not a ledger; an upsert keeps the existing usage log). */
	upsertSource(source: NotesSource): void;
	/** Every notes source record, by id order-insensitive. */
	readSources(): NotesSource[];
	/** Append one run's usage to a source record — idempotent per
	 *  startedAt, mirroring ChatRecord.extractions. */
	appendSourceUsage(id: string, entry: ExtractionRunUsage): void;

	/** The layout ledger (POSITIONS_FILE): nodeId → resting {x,y}. */
	readPositions(): Record<string, Position>;
	/** Replace the whole ledger (the settle is a full-graph computation). */
	writePositions(positions: Record<string, Position>): void;

	/** THE DESTRUCTIVE SEAM — the only non-append operation on these
	 *  ledgers: atomically replace the full contents of any subset of the
	 *  four ledgers (files.ts LEDGER_FILES). Each provided array is written
	 *  to a temp file and renamed over the ledger (crash-safe: a torn write
	 *  never replaces the original); absent keys leave their ledger
	 *  untouched. The pure computation is model/deletion.ts — the store only
	 *  makes the replacement atomic. */
	rewriteLedgers(next: {
		nodes?: GraphNode[];
		chains?: GraphChain[];
		coverage?: CoverageEntry[];
		checkpoints?: SessionCheckpoint[];
	}): void;
}
