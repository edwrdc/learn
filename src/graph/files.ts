import path from "node:path";
import { PATHS } from "../platform/index.ts";

/**
 * The LIVE graph store (src/store/graph.ts) — owned by the app's extraction
 * pipeline. Line shapes: src/core/contracts.ts. CHAINS ARE THE STORED
 * TRUTH (owner, 2026-09-30): edges are a derived view, never stored.
 */
export const LEDGER_FILES = {
	nodes: path.join(PATHS.graph, "nodes.jsonl"),
	chains: path.join(PATHS.graph, "chains.jsonl"),
	/** Session checkpoints. */
	checkpoints: path.join(PATHS.graph, "sessions.jsonl"),
	/** Per-message extraction coverage (contracts/graph.ts CoverageEntry;
	 *  the checkpoint's replacement for chat extractions — notes keep
	 *  sessions.jsonl, whole-file as they are). */
	coverage: path.join(PATHS.graph, "coverage.jsonl"),
} as const;

/**
 * Notes-import bookkeeping (NOT a ledger): one JSON map, src-id → NotesSource
 * record (contracts/graph.ts) — the file path + import time + the run's usage
 * log. Read-modify-write like a chat file, not append-only like the ledgers.
 */
export const SOURCES_FILE = path.join(PATHS.graph, "sources.json");
/** The layout ledger (read-modify-write like sources.json): nodeId →
 *  {x,y} resting positions from the incremental settle (core/layout.ts).
 *  Carries an updatedAt stamp for future live-physics conflict handling. */
export const POSITIONS_FILE = path.join(PATHS.graph, "positions.json");

/** The graph-family FORMAT STAMP sidecar (schema-versioning wave,
 *  2026-10-10): one version for the whole family — the four JSONL ledgers
 *  and sources.json. LAZY v1: absent = v1; the first
 *  graph-family write creates it. positions.json is REBUILDABLE and rides
 *  along unversioned by design (owner ruling). */
export const GRAPH_FORMAT_FILE = path.join(PATHS.graph, "format.json");

/** Every graph data file: a write to any of them moves graphRevision. */
export const GRAPH_FILES = [...Object.values(LEDGER_FILES), SOURCES_FILE, POSITIONS_FILE, GRAPH_FORMAT_FILE];
