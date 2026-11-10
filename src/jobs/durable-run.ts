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
import type { ModelRole } from "../settings/model/index.ts";
import type { JobUsage } from "./model/types.ts";
import type { JobKind, SearchProvider } from "../tools/model/index.ts";
import type { ModelSnapshot, PiEngine } from "../platform/index.ts";
import type { GraphDeps } from "../graph/index.ts";
import type { HeadlessApi } from "./headless.ts";
import { processState } from "../platform/model/index.ts";

/** The roles the durable background runner drives. */
export type BackgroundKind = JobKind | "extract" | "audit" | "compact";

/** A run's role: the settings-resolved job roles, plus the compaction
 *  summarizer, which runs the chat's own engine and resolves no role. */
type RunRole = ModelRole | "compact";

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

interface CompactRunState {
	kind: "compact";
}

export type RunState =
	| ResearchRunState
	| DemoRunState
	| VisualRunState
	| PdfRunState
	| SubmitRunState
	| CompactRunState;

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
	model: ModelSnapshot;
	/** The child conversation's provider session id; the Models router keys
	 *  this run's engine binding on it. */
	sessionId: string;
	maxTurns: number;
	systemPrompt: string;
	prompt: string;
	input: JsonObject;
	state: RunState;
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
	/** The caller's search seam (tests); production falls back to the host. */
	search?: () => SearchProvider | null;
	/** The caller's headless seam (tests); production falls back to the host. */
	headless?: HeadlessApi;
	/** The graph the auditor's exploration tools read (extraction passes
	 *  its own; otherwise the app's stores). */
	graph?: GraphDeps;
	/** Aborting stops the child conversation's spend; the run stays
	 *  recoverable. */
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

/** A user message's content inside a role's own conversation. */
export type RoleMessageContent = string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

/** Read/modify one role's persisted state. Tools use it to read the state
 *  they edit (e.g. the current SVG) and to commit progress before their
 *  result; the durable layer owns the doc. `append` lands a user message in
 *  the same commit as the state change. */
export interface RoleStateIo<T extends RunState> {
	read(): Promise<T>;
	update(mutate: (state: T) => void, append?: RoleMessageContent): Promise<void>;
}

/** Host services the background runtime cannot import from the composition
 *  root (boot configures them). */
interface BackgroundServices {
	/** Resolve the engine for a stored descriptor (settings + credential
	 *  snapshot read fresh; never persisted). */
	resolveEngine(descriptor: RunDescriptor): PiEngine | undefined;
	searchProvider(): SearchProvider | null;
	/** Verification engines (tests inject; production uses the app's own
	 *  browser/native rasterizers). */
	headless?(): HeadlessApi;
	/** Run (or reattach to) one role conversation (jobs/runtime.ts; tests
	 *  replace it to script a summary). */
	run(request: BackgroundRunRequest): Promise<BackgroundRunResult>;
}

export function backgroundServices(): Partial<BackgroundServices> {
	return processState("backgroundServices", () => ({ services: {} as Partial<BackgroundServices> })).services;
}

/** Boot sets every service; a test replaces only the ones it fakes. */
export function configureBackgroundRuns(next: Partial<BackgroundServices>): void {
	Object.assign(backgroundServices(), next);
}

/** Run (or reattach to) one role conversation through the durable Harness. */
export function backgroundRun(request: BackgroundRunRequest): Promise<BackgroundRunResult> {
	const run = backgroundServices().run;
	if (!run) throw new Error("background runs are not configured (boot)");
	return run(request);
}

/** Where a role's durable run lives: the runtime owner and its stable key. */
export interface RoleRunIdentity {
	chatId: string;
	jobId: string;
}

/** A run that ended without an answer; `state` is what it had reached. */
export class RunFailure extends Error {
	constructor(
		message: string,
		readonly state: RunState | undefined,
	) {
		super(message);
		this.name = "RunFailure";
	}
}
