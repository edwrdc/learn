/**
 * The durable background-run contract (pi-durable migration, unit C).
 *
 * Every background model loop — the job roles (research, demo, visual,
 * PDF), the extraction submit stages (extractor, auditor) and the
 * compaction summarizer — is a durable child conversation driven through
 * this one seam. The seam lives in the agent layer because the agent layer
 * may not import the server composition; `chat-handler` wires it to
 * `src/server/durable-background.ts`.
 *
 * The persisted domain shape is `RunDescriptor` plus the discriminated
 * `RunState` union below: a later process rebuilds the role's tools, prompt,
 * model and caps from the descriptor, and reads the role's own progress
 * (pages read, the current SVG, a validated submit) from `state`.
 */

import type { JsonObject } from "@earendil-works/pi-durable";
import type { Usage } from "@earendil-works/pi-ai";
import type { ModelRole } from "../../../config.ts";
import type { JobUsage } from "../../core/contracts.ts";
import type { SearchProvider } from "../../core/search.ts";
import type { PiEngine } from "../models.ts";
import type { GraphToolContext } from "../tools/graph.ts";
import type { AppToolResult } from "../tool-adapter.ts";
import type { HeadlessApi } from "./headless.ts";

/** The roles the durable background runner drives. */
export type BackgroundKind = "research" | "demo" | "visual" | "pdf" | "extract" | "audit" | "compact";

/** A run's role: the settings-resolved job roles, plus the compaction
 *  summarizer, which runs the chat's own engine and resolves no role. */
export type RunRole = ModelRole | "compact";

/** A demo verification result without the unconstrained probe value: the
 *  persisted state must stay JSON. */
export interface DemoVerification {
	consoleErrors: string[];
	pageErrors: string[];
	failedRequests: string[];
	ok: boolean;
}

/** Role state that must survive a restart; never a closure variable. */
export interface ResearchRunState {
	kind: "research";
	fetchedUrls: string[];
}

export interface DemoRunState {
	kind: "demo";
	html: string | null;
	/** The html the last run_demo tested (null = never tested). */
	testedHtml: string | null;
	lastResult: DemoVerification | null;
}

export interface VisualRunState {
	kind: "visual";
	currentSvg: string | null;
	/** The svg shown in the most recent render (null = never rendered). */
	renderedSvg: string | null;
	/** A render of `currentSvg` is committed by the tool and awaits the image
	 *  message the after-tools hook appends. */
	pendingRender: boolean;
	/** The final verification render failed (the old loop's hard failure). */
	renderError?: string;
}

export interface PdfRunState {
	kind: "pdf";
	/** Every page the reader extracted or rendered (the citation set). */
	consulted: number[];
	/** Pages genuinely read — extract or render output entered the loop. */
	read: number[];
	pendingRender: { pages: number[]; dpi: number } | null;
	/** The doctrine gate could not run at the turn cap: the run ends like the
	 *  old loop's iteration limit, never delivering an unread brief. */
	blockedAtCap?: boolean;
}

export interface SubmitRunState {
	kind: "extract" | "audit";
	/** The validated submit value, captured before its tool result. */
	submitted: JsonObject | null;
}

export interface CompactRunState {
	kind: "compact";
}

export type RunState =
	| ResearchRunState
	| DemoRunState
	| VisualRunState
	| PdfRunState
	| SubmitRunState
	| CompactRunState;

/** The safe (secret-free) selection stored for recovery. */
export interface RunModel {
	provider: string;
	modelId: string;
	thinking?: string;
	/** Endpoint snapshot identity for a custom provider (never a credential). */
	baseUrl?: string;
}

export interface RunDescriptor {
	/** Stable run identity (the durable index key and role-factory input). */
	runId: string;
	/** The run's reattach key — a job id for job roles, a deterministic
	 *  source/prompt identity for extraction and compaction. */
	jobId: string;
	/** The runtime owner: the chat id, or a notes source id. */
	chatId: string;
	kind: BackgroundKind;
	role: RunRole;
	model: RunModel;
	/** The child conversation's provider session id; the Models router keys
	 *  this run's engine binding on it. */
	sessionId: string;
	maxTurns: number;
	systemPrompt: string;
	prompt: string;
	input: JsonObject;
	state: RunState;
	activity: string;
	/** Set by the durable cap hook: the turn budget ended the run. */
	capped?: boolean;
}

/** One completed assistant step, oldest first (aborted attempts excluded). */
export interface RunStep {
	/** 1-based step number (the model call's ordinal in this run). */
	step: number;
	/** provider:id of the model that ran. */
	model: string;
	usage: Usage;
	finishReason: string;
	tools: string;
}

/** What one role run needs at start. */
export interface BackgroundRunRequest {
	/** Stable reattach identity (see RunDescriptor.jobId). */
	jobId: string;
	/** The runtime owner: the chat id, or a notes source id. */
	chatId: string;
	kind: BackgroundKind;
	role: RunRole;
	/** The engine resolved and key-gated by the caller for a FRESH run
	 *  (ignored when the durable index already has this run). */
	engine: PiEngine;
	maxTurns: number;
	systemPrompt: string;
	prompt: string;
	input?: JsonObject;
	attachments?: { pdfDir?: string };
	/** The caller's search seam (tests); production falls back to the host. */
	search?: () => SearchProvider | null;
	/** The caller's headless seam (tests); production falls back to the host. */
	headless?: HeadlessApi;
	/** The caller's graph context for the auditor's exploration tools
	 *  (tests); production falls back to the host's real stores. */
	graph?: GraphToolContext;
	/** The job's abort controller: firing it makes the caller's own
	 *  `abortSignal.aborted` guard see the kill, exactly like a pi loop. */
	abort?: AbortController;
	/** A non-job caller's abort signal (extraction, compaction): aborting the
	 *  child conversation stops the spend; the run stays recoverable. */
	signal?: AbortSignal;
	onActivity?: (line: string) => void;
	onUsage?: (usage: JobUsage) => void;
	onStep?: (step: RunStep) => void;
}

export interface BackgroundRunResult {
	text: string;
	state: RunState;
	/** The turn cap ended the run (not a model answer). */
	capped: boolean;
	/** Every completed assistant step of the run, oldest first. */
	steps: RunStep[];
}

/** Read/modify one role's persisted state. Tools use it to read the state
 *  they edit (e.g. the current SVG) and to commit progress before their
 *  result; the durable layer owns the doc. */
export interface RoleStateIo<T extends RunState> {
	read(): Promise<T>;
	update(mutate: (state: T) => void): Promise<void>;
}

export type DurableBackgroundRun = (request: BackgroundRunRequest) => Promise<BackgroundRunResult>;
export type DurableBackgroundRetire = (chatId: string, jobId: string) => Promise<void>;

let backgroundRunSeam: DurableBackgroundRun | undefined;
let backgroundRetireSeam: DurableBackgroundRetire | undefined;

/** chat-handler wires these at module init (the durable runtime lives in the
 *  server layer; the agent layer keeps only the role seams). */
export function setBackgroundRun(run: DurableBackgroundRun): void {
	backgroundRunSeam = run;
}

export function setBackgroundRetire(retire: DurableBackgroundRetire): void {
	backgroundRetireSeam = retire;
}

/** Run (or reattach to) one role conversation through the durable Harness. */
export function backgroundRun(request: BackgroundRunRequest): Promise<BackgroundRunResult> {
	if (!backgroundRunSeam) throw new Error("background runner seam is not wired (setBackgroundRun)");
	return backgroundRunSeam(request);
}

/** Drop a run the caller has consumed (a second identical extraction is a
 *  fresh run, not a replay of a settled one). A crash before this call
 *  leaves the entry for the restart to reattach. */
export async function retireBackgroundRun(chatId: string, jobId: string): Promise<void> {
	await backgroundRetireSeam?.(chatId, jobId);
}

/** Initial role state for a fresh run. */
export function initialState(kind: BackgroundKind): RunState {
	switch (kind) {
		case "research":
			return { kind: "research", fetchedUrls: [] };
		case "demo":
			return { kind: "demo", html: null, testedHtml: null, lastResult: null };
		case "visual":
			return { kind: "visual", currentSvg: null, renderedSvg: null, pendingRender: false };
		case "pdf":
			return { kind: "pdf", consulted: [], read: [], pendingRender: null };
		case "extract":
		case "audit":
			return { kind, submitted: null };
		case "compact":
			return { kind: "compact" };
	}
}

/** Where a role's durable run lives: the runtime owner and its stable key. */
export interface RoleRunIdentity {
	chatId: string;
	jobId: string;
}

export function textResult(text: string): AppToolResult {
	return { content: [{ type: "text", text }] };
}
