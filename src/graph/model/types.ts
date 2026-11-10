/**
 * Knowledge-graph contracts — nodes, ledgers, extraction findings.
 *
 * Every node is a TRUE proposition; reasoning chains are the stored truth;
 * provenance is message-granular; extraction is post-hoc, decoupled from
 * the session's plan tree. The graph is the reasoning chains extracted from
 * all teaching sessions (and imported notes) — NOTHING else: no quiz
 * outcomes, no understanding assessments. See docs/vision.md.
 */

import type { RefusalCode } from "../../settings/model/index.ts";

import type { ExtractionRunUsage, ExtractionStageUsage } from "../../session/model/index.ts";

/** One relation of the DERIVED view — chains are the stored truth ("the
 *  graph is a lossy image of what is truly stored"), and
 *  the snapshot derives UNTYPED arrows from them: every premise → the
 *  chain's implication node, the implication node → the conclusion.
 *  Nothing stores or mutates these — they are rebuilt after every change
 *  and never converted back. */
export interface GraphEdge {
	from: string;
	to: string;
}

/** One stored REASONING CHAIN — an argument: premises that JOINTLY entail
 *  the conclusion. Independent arguments
 *  for the same conclusion are separate chains (they may share `conclusion`);
 *  co-premises within one chain are used TOGETHER. The snapshot derives an
 *  implication NODE per chain (id = the chain id — the arg_ namespace is its
 *  own, collision-free with n_) plus untyped edges premises → imp →
 *  conclusion. A chain referencing a dead node dies with it (full death
 *  cascades through every referencing chain). */
export interface GraphChain {
	/** "arg_" + nanoid-like (store-assigned, the node-minting pattern). */
	id: string;
	/** Node ids of the argument's premises — at least one, jointly
	 *  sufficient. Extractor-local at the wire; node ids after resolution. */
	premises: string[];
	/** The node id the premises jointly imply. */
	conclusion: string;
	/** Every (chat, message) point where this argument was asserted —
	 *  unioned across assertion lines at read time. */
	provenance: ProvenancePoint[];
	createdAt: string;
}

/** What one extraction run merged into the graph ledgers — the merger's
 *  output, also persisted in extraction-run usage records. */
export interface EmissionStats {
	/** New graph nodes appended. */
	nodes: number;
	/** New reasoning chains appended. */
	chains: number;
	/** Chains the simplification pass removed in this merge
	 *  (ancestry-cover / prefer-fewest-premises).
	 *  Maintenance, not extraction: appends are counted in `chains`
	 *  regardless. Undefined when nothing dropped (pre-simplification
	 *  records read as zero). */
	droppedChains?: number;
}

/** One provenance point — message-granular: nodes and chains record every (chat, message) where they came up, deep-linkable to
 *  the exact transcript point. */
export interface ProvenancePoint {
	/** The chat this point anchors to — or a notes source id ("src_…"):
	 *  imports carry no message anchors (provenance is the file itself). */
	chatId: string;
	messageId: string;
}

/** One imported notes file — the format-agnostic front door's bookkeeping:
 *  personal notes in ARBITRARY formats run through the
 *  same extractor → auditor → merger pipeline, with the file itself as the
 *  provenance anchor. There is no chat: the detail card shows the file path
 *  as a STATIC entry (not a link). The run's usage log lives here,
 *  mirroring ChatRecord.extractions. Ids are "src_" + hash of the file
 *  path — deterministic, so re-importing the same file re-runs extraction
 *  against the same source id. */
export interface NotesSource {
	id: string;
	filePath: string;
	/** ISO — when this file was imported (the checkpoint's foldedAt). */
	importedAt: string;
	/** The run's usage log — same append-only discipline as
	 *  ChatRecord.extractions, idempotent per startedAt. */
	extractions?: ExtractionRunUsage[];
}

/** The graph-family format version this build writes and understands
 *  (the format.json sidecar — graph-format.ts). */
export const CURRENT_GRAPH_FORMAT_VERSION = 1;


export interface GraphNode {
	/** Opaque stable id, store-assigned: "n_" + nanoid-like. */
	id: string;
	/** A very short label for the node — a compact handle like a glossary
	 *  headword ("Will to power", "Divine command theory"): what the graph
	 *  shows at a glance. Presentational only — not unique, not an identity
	 *  key, never precise: the statement carries the precision. Set at
	 *  creation (first line defines); a link-append never changes it. */
	name: string;
	/** The minimal proposition — one true, self-contained statement, at
	 *  full precision. The IDENTITY ANCHOR: the auditor recognizes a
	 *  re-encounter by judgment against this (link-or-create), not by
	 *  string matching. Shown in the detail card; the canvas label is the
	 *  name. */
	statement: string;
	/** Verbatim phrasings sessions used for this proposition (the identity
	 *  audit trail — how the world said what the node says). */
	aliases: string[];
	createdAt: string;
	/** Every (chat, message) point where this proposition came up. */
	provenance: ProvenancePoint[];
}

/** sessions.jsonl line — the emission checkpoint for one chat (which chats
 *  have been folded, and through which updatedAt — never fold twice). */
export interface SessionCheckpoint {
	chatId: string;
	/** The chat record's `updatedAt` at the time of the fold. */
	foldedAt: string;
}

/** coverage.jsonl line: ONE MESSAGE of one chat has been extracted — by content fingerprint over
 *  exactly what the extraction view sees. The MESSAGE is the unit of
 *  coverage; "uncovered" is derived (fingerprint the current transcript,
 *  diff) — never dual-tracked. A message whose teacher prose changes
 *  re-opens itself, only itself. Chat extractions write these instead of whole-chat checkpoints;
 *  notes imports keep the checkpoint (a file is one shot). */
export interface CoverageEntry {
	chatId: string;
	/** sha256 of the message's view lines — "covered" means exactly this. */
	fp: string;
	/** chars/4 estimate of the message's view — display + budgeting. */
	tokens: number;
	/** ISO — when this message's last extraction run merged. */
	foldedAt: string;
}

/**
 * Store format: JSONL ledgers (files.ts LEDGER_FILES), all append-only —
 * see store.ts. Edges are NEVER stored — the derived view (implication
 * nodes + untyped arrows) is rebuilt from chains on every read.
 *
 *   nodes.jsonl    the FIRST line for an id defines name/statement/
 *                  createdAt; later lines for the same id are
 *                  link-appends (a session's re-encounter): their
 *                  statements/aliases join `aliases`, their provenance
 *                  unions; the name stays the first line's.
 *   chains.jsonl   one line per chain ASSERTION; readers merge by
 *                  (premises, conclusion), unioning provenance — the
 *                  first line's arg_ id is the chain's identity.
 */

// ─── Extraction findings (extractor output → audit → merger input) ───────────

/** One identity verdict: the extractor's local proposition id → the
 *  EXISTING graph node that proposition IS. On link, the session's
 *  phrasings (statement, aliases) join the node's aliases and the
 *  provenance unions. EQUIVALENCE BIAS: paraphrases,
 *  rewordings, and compressions of the same claim MERGE — do not create
 *  a duplicate because the wording differs. Only genuinely distinct
 *  propositions stay apart. */
interface IdentityLink {
	id: string;
	linkTo: string;
}

/** The auditor's output — VERDICTS ONLY: the deterministic merger joins
 *  findings + verdicts. `links` = the identity verdicts (local id ⇄
 *  existing node) — the auditor's ENTIRE deliverable. No drop channel —
 *  the auditor never rejects; the extractor is fully trusted. */
export interface AuditVerdicts {
	links: IdentityLink[];
}

/** One rendered cluster in the snapshot payload. Members are
 * node ids; the renderer draws the hull from member positions at draw
 * time and gates the label inversely on the node-label zoom control. */
export interface Cluster {
	/** The birth session's id (chat id or notes src id). */
	id: string;
	/** The session's name; null when its record is gone (deleted chat). */
	label: string | null;
	/** Node ids, sorted. Hull + centroid are renderer concerns. */
	members: string[];
}

/** The GET /api/graph payload — everything the home view's PURE renderer needs. */
export interface GraphSnapshot {
	/** Proposition nodes + the DERIVED implication nodes (one per chain,
	 *  id = chain id) — what the canvas renders. */
	nodes: GraphNode[];
	/** The STORED proposition nodes alone (no derived implication nodes)
	 *  — the stored truth, like `chains`: consumers that read the world
	 *  (the chain table) take this list, never the canvas image. */
	propositions: GraphNode[];
	/** DERIVED untyped arrows: premise → imp → conclusion. A lossy image
	 *  of the stored chains — rebuilt after every change, never stored. */
	edges: GraphEdge[];
	/** DERIVED LOGICAL arrows: every chain contracted to direct premise→
	 *  conclusion over PROPOSITION ids only (the imp hop collapsed). The
	 *  depth pass consumes these — inference depth is a property of
	 *  propositions, never of the geometry point. */
	logicalEdges: GraphEdge[];
	/** DERIVED imp linkage (one per MULTI-premise live chain): the depth
	 *  pass anchors each junction at the average of the highest premise
	 *  row and the conclusion's row — strictly
	 *  above the premises, strictly below the conclusion. */
	impLinks: Array<{ id: string; premises: string[]; conclusion: string }>;
	/** The STORED reasoning chains (merged by (premises, conclusion) at
	 *  read): the chain table's and the practice pipeline's input — they
	 * read the truth, never the derived fan-out. */
	chains: GraphChain[];
	/** chatId → title, for every chat that touched the graph. */
	sessions: Record<string, string>;
	/** srcId → file path, for every IMPORTED NOTES file that touched the
	 *  graph (the format-agnostic front door): a static provenance entry —
	 *  the detail card shows the path as plain text, not a link. */
	fileSources: Record<string, string>;
	/** nodeId → chatIds that touched the node (click-through provenance). */
	nodeSessions: Record<string, string[]>;
	/** Birth-session communities (session-clusters.ts: each
	 * proposition joins the cluster of the session that birthed it),
	 * MIN_CLUSTER_SIZE
	 * ≥ 3 as the hull presentation rule. Propositions only — implication
	 * nodes are never partitioned. Purely provenance-derived — never
	 * depends on layout. */
	clusters: Cluster[];
	/** Resting layout positions per node id, when a positions ledger
	 *  exists (layout-settle.ts writes it). Absent on a fresh graph —
	 *  the view then falls back to its own one-shot forceAtlas2 pass. */
	positions?: Record<string, Position>;
}

/** A node's resting position in layout space (the positions ledger). */
export interface Position {
	x: number;
	y: number;
}

export type ExtractionPhase = "queued" | "extracting" | "waiting" | "auditing" | "merging";

/** One running extraction job as GET /api/graph/status reports it. */
export interface ExtractionRunView {
	/** The job's own key; one source's chunk rows share chatId. */
	id: string;
	chatId: string;
	part?: { i: number; n: number };
	/** The run's label (a notes file path), else the chat's title, plus the
	 *  chunk suffix ("· 2/5") when the source fanned out. */
	title: string;
	phase: ExtractionPhase;
	startedAt: number;
	usage: { extractor?: ExtractionStageUsage; auditor?: ExtractionStageUsage };
}

/** One file's outcome in POST /api/graph/import. A config refusal carries
 *  the refusal envelope's code and specifics. */
export interface NotesImportResult {
	requestIndex: number;
	filePath: string;
	ok: boolean;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	stats?: EmissionStats;
	error?: string;
	code?: RefusalCode;
	missing?: string[];
	provider?: string;
	slots?: string[];
}
