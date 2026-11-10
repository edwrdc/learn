/**
 * Chat-session contracts — records, summaries, UI extension points.
 * Pure types + protocol docs + tiny pure helpers. See docs/vision.md.
 */
import type { ModelChoice } from "../../settings/model/index.ts";
import type { Usage } from "@earendil-works/pi-ai";
import type { LhMessage } from "./transcript.ts";
import type { Phase3 } from "./phases.ts";
import type { PlanNodeStatus, PlanTree } from "./plan-types.ts";
import type { EmissionStats } from "../../graph/model/index.ts";

// ─── Chat records (the session store's on-disk format) ───────────────────────

/** The session's kind: "teach" is the default and ABSENT on pre-practice
 *  records (no migration — absence reads as teach); "practice" marks an
 *  adaptive-practice session — the practice agent and its tools, no
 *  extraction, no graph writes. */
type ChatKind = "teach" | "practice";

/** One persisted session: metadata in data/chats/<id>.json, transcript in
 * the durable store. `messages` is pi-NATIVE history (LhMessage); the
 * client-shaped view is the client's own grouping fold (view.ts) — a
 * pending quiz is an unanswered question tool call, which is exactly what
 * makes resume-mid-question free. */
export interface ChatRecord {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messages: LhMessage[];
	/** The session's kind — absent = teach (pre-practice records). */
	kind?: ChatKind;
	/** The session's plan tree (vision §2) — written by plan tools via saveTree. */
	tree?: PlanTree;
	/** Append-only usage log: one entry per model turn. DELIBERATELY a
	 * parallel log, not per-message metadata. Keyed by messageId so the
	 * transcript view can fold each entry onto its message; aggregates are
	 * folds over this log (prices.ts). */
	turns?: TurnUsage[];
	/** Append-only background-extraction usage log: one entry per finished pipeline run on THIS chat — extraction is real
	 *  spend too. Same parallel-log discipline as `turns` (nothing rides
	 *  inside messages). Keyed by startedAt; idempotent appends. */
	extractions?: ExtractionRunUsage[];
	/** Per-chat model/thinking overrides for the conversation agents. */
	settings?: ChatSettings;
	/** SCHEMA STAMP: LAZY —
	 *  existing records stay unstamped; every write stamps the current
	 *  version. v1 carries `messages`; v2 is metadata-only and reads the transcript from the durable store. A
	 *  record stamped NEWER than this build (the downgrade scenario) is
	 *  REFUSED on read: a read-modify-write store must never rewrite what
	 *  it doesn't understand — and an old build must not read a v2 record
	 *  as its own chat format. */
	version?: number;
}

/** The chat record format this build writes and understands. */
export const CURRENT_CHAT_VERSION = 2;

/** A chat's own model settings, over the strong slot. Written by the model
 *  picker (PUT /api/chats/[id]/settings) and read at turn composition, so
 *  a change takes effect on the next turn. Background sub-agents are NEVER
 *  overridden. */
export type ChatSettings = ModelChoice;


// ─── Background-extraction usage (the money channel, extraction side) ────────

/** One pipeline stage's model usage — the stage's model + every step it
 *  billed (CallUsage per agent step). Steps, not a sum: cost and context
 *  folds happen at read time (prices.ts). */
export interface ExtractionStageUsage {
	/** The model that ran this stage, provider-qualified ("provider:id" —
	 *  matches PRICES' uniform keys). */
	model: string;
	steps: CallUsage[];
}

/** One finished (or failed mid-flight) extraction run's usage record.
 *  Appended to the chat's `extractions` log when the run ends — success or
 *  failure, because money was spent either way; `stats` is present only
 *  when the merger actually ran. */
export interface ExtractionRunUsage {
	/** The run's registry startedAt (ms) — the idempotency key. */
	startedAt: number;
	at: string;
	durationMs: number;
	/** What the run merged into the graph; absent when it failed first. */
	stats?: EmissionStats;
	/** Model usage per stage, in pipeline order (merger is deterministic —
	 *  no model call, no entry). */
	stages: {
		extractor: ExtractionStageUsage;
		auditor: ExtractionStageUsage;
	};
}

// ─── Usage accounting (the money channel) ─────────────────────────────────────

/** One model call's token accounting — flattened to the fields we persist (undefined = provider didn't report;
 * renderers show absent, never zero). */
export interface CallUsage {
	/** Total input (prompt) tokens, cached portion included. */
	inputTokens: number | undefined;
	outputTokens: number | undefined;
	/** Cached input tokens READ (billed at the cache-read rate, if any). */
	cacheReadTokens: number | undefined;
	/** Input tokens written to the cache this call (OpenRouter bills writes
	 * for some providers; undefined = not reported/not billed). */
	cacheWriteTokens: number | undefined;
	/** The reasoning portion of the output tokens. */
	reasoningTokens: number | undefined;
}

/** One provider call's usage as pi reports it; a field pi leaves unset
 *  stays undefined. */
export function usageFromPi(usage: Usage): CallUsage {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		reasoningTokens: usage.reasoning,
	};
}

/** One billing turn: one full invocation of the teacher (a client turn or a
 * wake turn — same handler, same log). A turn with tool calls spans several
 * agent steps, and each step bills separately. Capture lands at the persist
 * seam (server); cost is INFERRED at read time from prices.ts. */
export interface TurnUsage {
	/** Unique per REQUEST (turn): one invocation of the handler — the
	 *  idempotency key for the append-only log. Continuation turns can share
	 *  a response message id; keying on messageId would swallow their usage. */
	id: string;
	/** The assistant message the turn produced — provenance, keys this
	 *  entry to the transcript (the block this turn "belongs" to). */
	messageId: string;
	at: string;
	/** The model that ran the turn, provider-qualified ("provider:id" —
	 *  matches PRICES' uniform keys). */
	model: string;
	/** One entry per agent step (model call) in this turn. */
	steps: CallUsage[];
}

// ─── Plan blocks (the plan lives in the chat) ────────────────────────────────

/** The model-facing text of the probe→teach handoff wake (the custom-message
 *  scheme): the wake message carries only the data-probe-handoff part, and
 *  the adapter flattens it to THIS. Single-sourced so the prober's seam, the
 *  tests, and reality can't drift apart.
 *
 *  REASONING-FIRST PACING: the wake is the one per-turn cue on the launch
 *  turn, and a bare dispatch order makes the teacher skip the deliberation
 *  the planning fragment asks for. So the wake paces it: reason out the
 *  optimal way to teach THIS person THIS thing BEFORE plan_init. plan_init
 *  is still the first tool, and presenting still ends the turn (the
 *  learner's next message is a natural reply — a change request or the
 *  go-ahead). */
export const HANDOFF_TEXT =
	"Next: plan the full teaching arc from my current understanding to the goal understanding. " +
	"Apply the teaching methodology in your system prompt, and find the optimal way to teach me this. " +
	"Find the unconditional truths, plan the motivated derivations/discoveries, so every reasoning step has to land as obviously true. " +
	"Take your time here and really think this through. " +
	"When it's genuinely reasoned out, call plan_init and present the plan; I'll accept it or ask for changes.";

// ─── Practice sessions — marker + ack texts ──────────────────────────────────
// Single-sourced here per the marker law: the model-facing text of every
// custom marker lives in the model layer, never in the flattening seam.

/** The model-facing register of a thinking submission (newThinkingMessage
 *  prefixes the learner's text with this label). One send lane — whether
 *  a submission claims an answer is read from the text, not declared by a
 *  button. */
export const THINKING_LABEL = "Your thinking";

/** The conclude tool's ack — shared by the executed call (agent layer) and
 *  the dismissal-synthesized pair (input-events), so a concluded problem
 *  reads identically to the model however it concluded. The turn ENDS after concluding (a system-prompt law, no tool-level
 *  terminate — the model may speak its closing words first, then must
 *  stop calling tools); the next problem waits for the learner's
 *  explicit go-ahead. */
export const CONCLUDE_ACK_TEXT =
	"Problem concluded. Say your closing words about the learner's work if useful, then END YOUR TURN — no further tool calls. The next problem is NEVER posed here: it waits for the learner's explicit go-ahead (a *Next problem* message, or their own words asking for the next one). Between problems, answer their questions about the concluded one.";

/** The learner's explicit move-on signal: the model-facing text of the practice-next marker — single-sourced
 *  like THINKING_LABEL. The button/Enter-on-empty path appends the
 *  marker; the model reads this and poses (or wraps) per the doctrine. */
export const NEXT_PROBLEM_TEXT =
	"[NEXT PROBLEM] — the learner's explicit go-ahead: pose the next problem now per the selection rules, or wrap the session in text if the arc is complete.";

/** The compaction marker's model-facing header. The marker's content is this header + the summary — the
 *  single text the provider sees in place of the dropped span. Wording
 *  law: it must tell the model (a) a cut happened and is routine, (b) the
 *  summary replaces everything before it, (c) what follows is verbatim
 *  recent transcript — so the model neither re-asks covered ground nor
 *  distrusts the seam. */
export const COMPACTED_HISTORY_HEADER =
	"[SESSION HISTORY COMPACTED] The transcript before this point was summarized to fit the context window; the summary below replaces it. Everything after this message is the verbatim recent transcript.";


/** Payload of the plan-block marker: a SNAPSHOT of the plan at authoring,
 *  rendered in the chat flow (UI-only, never model-facing). */
export interface PlanBlockData {
	/** Always "full": the plan renders IN FLOW once, at authoring; position
	 *  derives live from the transcript. */
	kind: "full";
	at: string;
	/** The current node at snapshot time (the glow target; null = none). */
	current: string | null;
	/** All nodes of the authored tree. Statuses are the snapshot's,
	 * derived at emission time — the block never re-derives at render. */
	nodes: Array<{ id: string; title: string; status: PlanNodeStatus }>;
	edges: Array<{ from: string; to: string }>;
}

/** The list view's shape (messageCount instead of full messages) + the
 *  per-session status the picker renders. `phase` and `pendingQuestion`
 *  derive from the stored messages; the store computes
 *  them in listChats. Liveness (`busy`) is NOT record-derived — the API
 *  route merges it in (see ChatListItem).
 *
 *  Phase semantics (three phases, event-driven — docs/probe-teach-split.md
 *  §4): probe ends at the concluded probe_done, plan ends at the first
 *  nodeId-tagged quiz/explain call; derived from the transcript
 *  (phases.ts phaseAt3Lh).
 */
export interface ChatSummary {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	/** Normalized kind (absent record field reads as teach). */
	kind: ChatKind;
	messageCount: number;
	/** The session's current phase, derived from the transcript. */
	phase: Phase3;
	/** An unanswered quiz/ask question is waiting for the learner. */
	pendingQuestion: boolean;
	/** Practice sessions: a posed problem with no conclude —
	 *  the sidebar meta's "Problem waiting". Absent on teaching sessions. */
	pendingProblem: boolean;
	/** The record's model-control settings — rides the list payload via the
	 *  summary spread (the picker never needs it from here; the full record
	 *  is its source). */
	settings?: ChatSettings;
}

/** The sidebar's session row: a summary + live liveness. The chats list
 *  route attaches `busy` from the turn-liveness registry ONLY — a running
 *  teach turn (background jobs do not count; the sidebar's Background
 *  agents section is their channel, and the row spinner means exactly "a
 *  turn is in flight"). The store itself can't see liveness, hence the
 *  split at exactly the record/liveness seam. */
export interface ChatListItem extends ChatSummary {
	busy: boolean;
	/** Live compaction liveness (turn-liveness's twin): true while a
	 *  background context compaction holds the chat's model gate. The
	 *  route attaches it from the compaction registry — never
	 *  record-derived (the marker persists, the RUN is ephemeral). */
	compacting: boolean;
}

// ─── Artifact renderer registry (client extension point) ────────────────────

/**
 * src/lib/chat/ArtifactPart.svelte renders any tool part it doesn't
 * specially handle, keyed by tool name ("research", "demo", "visual", …).
 * Renderer receives the raw tool part; it typically renders
 * an activity card while state is input-available (poll /api/jobs) and the
 * artifact (iframe / svg) when output-available.
 */
export interface ArtifactPartProps {
	part: {
		type: string;
		state: string;
		toolCallId: string;
		input?: unknown;
		output?: unknown;
		/** The pose-side fold: the whole problem-call
		 * arguments joined onto the conclude part by projectView — the
		 * observability drawer's data. */
		problemInput?: unknown;
		/** The view-seam join for conclude cards: the modelSolution committed at POSE time, folded onto the part by
		 *  projectView — the reveal is never re-authored. */
		reveal?: unknown;
	};
}

// ─── Session coverage (extraction-UX read: ring meter + popover) ────────────

/** One session's coverage read: the chat view's ring meter + popover
 *  data, scoped to one chat. Uncovered stays DERIVED per request (fingerprint the transcript,
 *  diff the coverage ledger — never dual-tracked).
 *
 *  lastFoldedAt: the newest coverage row's fold timestamp — a cheap single
 *  pass over the chat's ledger rows (the ring popover's "last extraction"
 *  line); null before the session's first fold. */
export interface SessionCoverage {
	totalMessages: number;
	coveredCount: number;
	uncoveredCount: number;
	coveredTokens: number;
	uncoveredTokens: number;
	/** True while a chat-kind extraction run is registered for this session. */
	running: boolean;
	/** ISO of the newest fold in this session's coverage rows; null before any. */
	lastFoldedAt: string | null;
}

/** GET /api/chats/:id: the record served verbatim (the client derives its
 *  view) plus liveness — a running turn to re-attach to, a compaction in
 *  flight — and the chat's coverage meter. */
export interface ChatView extends ChatRecord {
	turnInFlight: boolean;
	compacting: boolean;
	coverage: SessionCoverage | null;
}
