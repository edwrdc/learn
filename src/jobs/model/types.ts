/**
 * Sub-agent job contracts — the async ack-and-steer protocol. Pure types +
 * protocol docs + tiny pure helpers. See docs/vision.md.
 */
import type { ExtractionRunView } from "../../graph/model/index.ts";
import type { CallUsage } from "../../session/model/index.ts";
import type { RefusalCode } from "../../settings/model/index.ts";
import type { LhMessage, LhMarkerMessage } from "../../session/model/index.ts";

// ─── Async sub-agent jobs ────────────────────────────────────────────────────

import type { JobKind } from "../../tools/model/index.ts";
import { JOB_TEXT } from "./job-text.ts";

export type { JobKind };
type JobStatus = "running" | "done" | "error";

export interface JobRecord {
	id: string;
	kind: JobKind;
	chatId: string;
	/** The tool part this job fulfills. */
	toolCallId: string;
	status: JobStatus;
	/** Latest human-readable activity line, e.g. `web_search: "sigma.js v3"`. */
	activity: string;
	createdAt: string;
	updatedAt: string;
	/** The sub-agent's result (steer-artifact payload). */
	result?: unknown;
	error?: string;
	/** Set when the job was refused before it ran (no model, no key). */
	refusal?: RefusalCode;
	/** Money channel: accumulated token usage of the sub-agent's run,
	 * written by the runner as steps complete. Cost is inferred at read time.
	 * Absent on older jobs and until the runner's capture lands — renderers
	 * show "—", never zero. */
	usage?: JobUsage;
}

/** A sub-agent run's accumulated usage — the same accounting shape as a
 * chat turn (CallUsage), flattened to one running total
 * plus a step count. Token fields are optional exactly like CallUsage: a
 * field NO model call reported stays undefined — absent is not zero (the
 * money-channel doctrine; cost renders "—", never $0). */
export interface JobUsage {
	/** The model that ran the sub-agent, provider-qualified ("provider:id" —
	 *  matches PRICES' uniform keys). */
	model: string;
	/** Running totals summed over the run's model calls so far. */
	inputTokens: number | undefined;
	outputTokens: number | undefined;
	cacheReadTokens: number | undefined;
	cacheWriteTokens: number | undefined;
	reasoningTokens: number | undefined;
	/** How many model calls the run has made (each bills separately). */
	steps: number;
	/** The MOST RECENT model call's accounting (the dock's contract): the
	 *  per-blob context line reads last-step input+output against the
	 *  model's LIVE catalog limit (server-joined onto the activity feed —
	 *  never the cumulative totals, never a client-side table). Absent
	 *  until the first call completes; absent provider fields stay absent
	 *  (never zero). */
	lastStep?: CallUsage;
}

/** Fold one model call's usage into the run's running total (pure). A
 * field neither the total nor the step reported stays undefined; once
 * reported, later unreported calls contribute 0. The `steps` counter is
 * the billing count: one per model call, reported or not. */
export function accumulateJobUsage(
	total: JobUsage | undefined,
	model: string,
	step: CallUsage,
): JobUsage {
	const add = (a: number | undefined, b: number | undefined): number | undefined =>
		a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
	return {
		model,
		inputTokens: add(total?.inputTokens, step.inputTokens),
		outputTokens: add(total?.outputTokens, step.outputTokens),
		cacheReadTokens: add(total?.cacheReadTokens, step.cacheReadTokens),
		cacheWriteTokens: add(total?.cacheWriteTokens, step.cacheWriteTokens),
		reasoningTokens: add(total?.reasoningTokens, step.reasoningTokens),
		steps: (total?.steps ?? 0) + 1,
		lastStep: step,
	};
}

/**
 * THE ASYNC PROTOCOL — "ack now, steer later":
 *
 *  1. Job tools (research / demo / visual / pdf) are SERVER-EXECUTED. The model
 *     calls one MID-TURN; execute creates the job record, fires the
 *     background runner, and resolves IMMEDIATELY with an acknowledgement
 *     ("dispatched — continue your turn"). The teacher's turn does NOT end
 *     at the call: it keeps teaching, may dispatch other independent jobs
 *     (full parallelism), and ends whenever it ends. The tool part's output
 *     is the ack, forever.
 *
 *  2. The background runner (runner.ts) runs the kind's sub-agent loop —
 *     isolated context, the verify-never-one-shot doctrine (headless-tested
 *     demos, looked-at SVGs, sourced briefs) — tracking a live activity line
 *     in the job record. The chat view's jobs fetch (GET /api/jobs?chatId=…,
 *     refetched on jobs-changed) drives every job surface: the transcript
 *     dispatch cards (live activity by toolCallId, quiet one-liner after
 *     delivery), the sub-agents sidebar panel, and the single re-sync when a
 *     job settles.
 *
 *  3. On completion the runner builds a STEER MESSAGE (buildSubagentSteer):
 *     a native marker whose content is what the MODEL needs (the research
 *     brief, the builder's notes) and whose details carry what the UI
 *     renders (the full result) — see "Sub-agent steer messages" below. The
 *     UI renders these as sub-agent result cards, NEVER as learner
 *     interjections.
 *
 *  4. The wake pipeline (wake.ts) delivers the steer — into a live run's
 *     durable inbox, or as ONE server-side wake turn once the chat is idle.
 *     Delivery is idempotent per steer id, so a crashed wake can be
 *     re-entered by the stale-job recovery sweep. The job's status flips to
 *     done/error only once the result is visible to the learner.
 *
 *  5. No pending job parts ever exist, so the composer never gates on jobs
 *     (the learner can interject mid-job).
 */

/** Every job result carries `failure` (the reason) when the job failed. */
interface JobFailure {
	failure?: string;
}

export interface ResearchResult extends JobFailure {
	brief: string;
	sources: { title: string; url: string }[];
}

export interface DemoResult extends JobFailure {
	title: string;
	/** Self-contained single-file HTML/JS document (sandboxed-iframe ready). */
	html: string;
	/** The builder sub-agent headlessly executed the demo before delivery. */
	tested: true;
	notes?: string;
}

export interface VisualResult extends JobFailure {
	/** Complete SVG markup (verified by the maker looking at the render). */
	svg: string;
	notes?: string;
}

export type JobResult = ResearchResult | DemoResult | VisualResult | PdfResult;

/** The pdf-reader: reads a learner-provided PDF on the teacher's behalf —
 *  triage, targeted extraction, look-at-the-page renders inside its own
 *  loop — and returns a text brief with page citations (owner decision:
 *  rendered images never leave the sub-agent's context; the teacher gets
 *  text). */
export interface PdfResult extends JobFailure {
	path: string;
	question: string;
	/** The distilled brief. Page citations inside the text point at
	 *  pagesConsulted. */
	brief: string;
	/** Pages the reader actually READ — extract or render output entered the
	 *  loop (the honest count for the UI badge; search-hit snippets don't
	 *  count — counting them overstated pages on search-first reads of long
	 *  books). */
	pagesRead: number[];
	/** Every page whose content entered the loop, search-hit context lines
	 *  included — the full audit set (the brief's citations may point here). */
	pagesConsulted: number[];
}

// ─── Sub-agent steer messages (THE ASYNC PROTOCOL §3–4) ─────────────────────
//
// Steers are NATIVE record messages — LhMarkerMessage customs (role
// "custom"), the custom-message taxonomy's wake members. The model-facing text rides `content` (single-sourced
// below); the UI payload (the artifact, the abort badge) rides `details`
// and never reaches the model (wireOf maps the marker to a user
// message carrying `content` only). The deterministic id (`steer_<jobId>`)
// IS the idempotency key — steerDelivered matches on it.

/** Message metadata marking a sub-agent steer. */
export interface SubagentResultMeta {
	jobId: string;
	kind: JobKind;
	toolCallId: string;
	/** Present only on an abort steer: the learner aborted the job (it
	 * lands as error "Aborted by learner"); the teacher is told so its
	 * promise of a result doesn't hang silently in the lesson. */
	aborted?: true;
}

/** The data-subagent-artifact part payload: what the UI renders. */
export interface SubagentArtifactData {
	kind: JobKind;
	result: JobResult;
	/** The learner's pinned UI state (invert switch) riding the record. */
	ui?: { inverted?: boolean };
}

/** A result steer's marker details: the UI's meta + artifact in one
 *  payload (the projection splits it into metadata + data part). */
export interface SteerDetails extends SubagentResultMeta {
	result: JobResult;
	/** LEARNER UI state pinned onto the artifact (owner decision): the
	 *  invert switch's position, persisted so navigating away and back (or
	 *  restarting) keeps it. A VIEW preference — never enters the teacher's
	 *  context, never exports (the markdown engine reads `result` only). */
	ui?: { inverted?: boolean };
}

/** The demo/figure steer with its invert switch set, or null when the id
 *  names no demo/figure steer. */
export function setSteerUiInverted(
	messages: readonly LhMessage[],
	messageId: string,
	inverted: boolean,
): LhMessage | null {
	const m = messages.find((message) => message.id === messageId);
	const d = (m as LhMarkerMessage | undefined)?.details as Partial<SteerDetails> | undefined;
	if (!m || !d || (d.kind !== "demo" && d.kind !== "visual")) return null;
	return { ...m, details: { ...d, ui: { ...d.ui, inverted } } } as LhMessage;
}

/** Anything the wake pipeline may queue and deliver — a native marker. */
export type SteerMessage = LhMarkerMessage;

export function isJobFailure(result: JobResult): boolean {
	return result.failure !== undefined;
}

/**
 * Build the steer message for a finished job (pure — shared by the runner,
 * the wake pipeline, and tests). Deterministic id per job makes re-delivery
 * idempotent.
 */
export function buildSubagentSteer(
	job: Pick<JobRecord, "id" | "kind" | "toolCallId">,
	result: JobResult,
): SteerMessage {
	return {
		id: `steer_${job.id}`,
		role: "custom",
		customType: "subagent-steer",
		content: result.failure !== undefined ? JOB_TEXT[job.kind].failed(result) : JOB_TEXT[job.kind].done(result),
		display: true,
		details: {
			jobId: job.id,
			kind: job.kind,
			toolCallId: job.toolCallId,
			result,
		},
		timestamp: Date.now(),
	};
}

/** Build the abort steer for an aborted job (pure — shared by abortJob
 * and tests). Same id as the result steer — exactly one delivers. */
export function buildAbortSteer(
	job: Pick<JobRecord, "id" | "kind" | "toolCallId">,
): SteerMessage {
	const meta = { jobId: job.id, kind: job.kind, toolCallId: job.toolCallId, aborted: true } as const;
	return {
		id: `steer_${job.id}`,
		role: "custom",
		customType: "subagent-abort",
		content: JOB_TEXT[job.kind].aborted,
		display: true,
		details: meta,
		timestamp: Date.now(),
	};
}


/** True when the transcript already carries this steer — idempotent
 *  delivery for ANY steer kind: every steer id is deterministic per its
 *  event (steer_<jobId> for jobs, steer_probe_<chatId> for the handoff). */
export function steerDelivered(messages: LhMessage[], steerId: string): boolean {
	return messages.some((m) => m.id === steerId);
}

/** A running sub-agent job joined with its chat's title. contextLimit is the
 *  model's catalog window, null when the catalog lacks the model (the dock
 *  then shows no context line rather than a fake window). */
export interface ActivityJob extends JobRecord {
	title: string;
	contextLimit: number | null;
}

/** One running extraction job (a multi-chunk source owns several). chatId is
 *  the source id; the title carries the "· i/N" chunk suffix. */
export type ActivityExtraction = Omit<ExtractionRunView, "usage">;

/** GET /api/activity: every running process, oldest first, plus the graph's
 *  version stamp. Cost folds are the client's. */
export interface ActivityFeed {
	jobs: ActivityJob[];
	extractions: ActivityExtraction[];
	graphRevision: number;
}
