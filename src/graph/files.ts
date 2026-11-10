import path from "node:path";
import { PATHS } from "../platform/index.ts";

/**
 * The graph ledgers (written through store.ts by the extraction pipeline).
 * Line shapes: model/types.ts. CHAINS ARE THE STORED TRUTH (owner
 * decision): edges are a derived view, never stored.
 */
export const LEDGER_FILES = {
	nodes: path.join(PATHS.graph, "nodes.jsonl"),
	chains: path.join(PATHS.graph, "chains.jsonl"),
	/** Session checkpoints. */
	checkpoints: path.join(PATHS.graph, "sessions.jsonl"),
	/** Per-message extraction coverage (CoverageEntry) for chats; notes
	 *  keep whole-file checkpoints in sessions.jsonl. */
	coverage: path.join(PATHS.graph, "coverage.jsonl"),
} as const;

/**
 * Notes-import bookkeeping (NOT a ledger): one JSON map, src-id → NotesSource
 * record — the file path + import time + the run's usage
 * log. Read-modify-write like a chat file, not append-only like the ledgers.
 */
export const SOURCES_FILE = path.join(PATHS.graph, "sources.json");
/** The layout ledger (read-modify-write like sources.json): nodeId →
 *  {x,y} resting positions from the incremental settle (model/layout.ts). */
export const POSITIONS_FILE = path.join(PATHS.graph, "positions.json");

/** The graph-family FORMAT STAMP sidecar (graph-format.ts): one version
 *  for the four JSONL ledgers and sources.json. positions.json is
 *  REBUILDABLE and rides along unversioned by design (owner decision). */
export const GRAPH_FORMAT_FILE = path.join(PATHS.graph, "format.json");

/** Every graph data file: a write to any of them moves graphRevision. */
export const GRAPH_FILES = [...Object.values(LEDGER_FILES), SOURCES_FILE, POSITIONS_FILE, GRAPH_FORMAT_FILE];
