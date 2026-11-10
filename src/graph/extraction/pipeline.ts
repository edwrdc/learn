import type { SessionFindings } from "../model/findings.ts";
import { abortError, isAbortError, tokensForChars } from "../../platform/model/index.ts";
import * as crypto from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type { ModelRole } from "../../settings/model/index.ts";
import {
	ModelsNotConfiguredError,
	ProviderKeyMissingError,
	ROLE_SLOT,
	type ModelSlotName,
	type ModelsNotConfigured,
	type ProviderKeyMissing,
} from "../../settings/model/index.ts";
import type { PiEngine } from "../../platform/index.ts";
import { BG_LLM_PERMITS, withBgLlmSlot } from "./llm-slots.ts";
import type { AuditVerdicts, CoverageEntry, ExtractionPhase, EmissionStats } from "../model/types.ts";
import { usageFromPi, type CallUsage, type ExtractionRunUsage, type ExtractionStageUsage } from "../../session/model/index.ts";
import { getGraph, mergeFindings, type DerivedGraph, type GraphDeps } from "../snapshot.ts";
import { emit, processState } from "../../platform/model/index.ts";
import { settleGraphLayout } from "../layout-settle.ts";
import { batchRuns, coverageOf, messageViewLines } from "../coverage.ts";
import type { LhMessage } from "../../session/model/index.ts";
import { runSubmitAgent } from "./submit-agent.ts";

/**
 * The extraction pipeline — the sole graph writer. Three stages, one
 * orchestrator:
 *
 *   extractor (LLM)  the ONE stage that sees the raw source (a session
 *                    rendered as the teacher's prose — each passage
 *                    labeled "TEACHER [id]" with its actual message id —
 *                    or a notes file verbatim, walked in stretches) →
 *                    submits NEW core ideas + reasoning chains; a session
 *                    submit additionally carries each proposition's
 *                    messageId — the anchor the merger stamps into the
 *                    node's message-granular provenance.
 *                    DIGEST-AWARE: when the source already yielded
 *                    material, the prompt carries THE GRAPH SO FAR (that
 *                    source's propositions + chains, ids verbatim) and the
 *                    extractor builds on it — referencing existing ids
 *                    instead of restating, leaning on established
 *                    conclusions as premises. Stretches of one source
 *                    run SERIALLY (each extract reads every earlier
 *                    merge); tree-blind, FULLY TRUSTED — nothing
 *                    downstream re-checks it.
 *   auditor (LLM)    never sees the source. Its job is IDENTITY: for each
 *                    NEW proposition, linkTo an existing graph node or
 *                    create — decided by EXPLORING the graph through
 *                    tools (find / list_sessions / list_propositions),
 *                    not by an injected graph dump (context bloat).
 *                    Links are its ONLY deliverable — it never mints
 *                    edges (owner decision: the graph connects across
 *                    sources solely through identified equivalences).
 *                    Input is PROPOSITIONS only — never chains.
 *   merger           mergeFindings() → deterministic ledger appends +
 *                    chain simplification (the ancestry-cover /
 *                    prefer-fewest-premises pass that strips redundant
 *                    derivations — snapshot.ts)
 *
 * The graph is purely extracted reasoning chains: quiz outcomes and
 * understanding observations are not recorded in it.
 *
 * The extractor is a single-tool-call worker (one TypeBox-validated submit
 * call — an agent loop purely so the model can retry a schema-invalid call).
 * The auditor is a small AGENTIC loop: exploration tools plus one submit.
 *
 * Created via createExtractionPipeline(deps) — the composition root
 * injects the storage ports + models. runExtraction is single-flight per
 * chat: a second trigger while one run is in flight is a no-op (the next
 * trigger picks up whatever the in-flight run missed).
 *
 * The FORMAT-AGNOSTIC FRONT DOOR: importNotes() runs the SAME three stages
 * over raw personal notes (arbitrary format — no chat, no session, no
 * message ids). A notes-mode extractor prompt replaces the session one;
 * the auditor and merger are shared. Provenance is the file itself:
 * source ids ("src_" + path hash) play the chatId role in mappings and
 * checkpoints, and the source record (graphStore sources seam) carries
 * the file path + the run's usage.
 *
 * Observability: every stage logs one line per step, its start, and its
 * duration; the pipeline logs a failure line before rethrowing, so the
 * server log reads start → stage timings → merged stats (or failed) for
 * every run.
 */

// ─── the source view (what the extractor sees) ──────────────────────────────

/** The extraction view: ONLY the teacher agent's text blocks — no learner
 *  messages, no thinking, no tool calls or results, no quiz blocks — as
 *  coverage.ts messageViewLines ("TEACHER [id] text"), the exact lines the
 *  coverage fingerprints hash, so the extractor can anchor every
 *  proposition to the passage it came from. The full session markdown
 *  (session/model/markdown.ts) is the user-facing export, not used here. */
function proseView(messages: ReadonlyArray<LhMessage>, title?: string): string {
	const lines = messages.flatMap((message) => messageViewLines(message, message.id));
	const head = title && title.length > 0 ? `# ${title}\n\n` : "";
	return head + lines.join("\n\n");
}

// ─── the extractor ──────────────────────────────────────────────────────────

// The submit wire shapes, weak-model fills and semantic validators live in
// ./submit-role.ts: the durable role factory rebuilds the exact same submit
// tool from the persisted run descriptor after a restart.

// ── the extractor's system prompt ──
//
// GOAL-FIRST, NO RULE ARMOR (owner decision): the prompt states the goal
// and the submission mechanics, not defensive rule lists; the tool's field
// descriptions carry the details. One shared core + two
// contextualizations — session and notes share the core by construction.

/** The session-only anchor instruction (owner wording, verbatim): every
 *  proposition names the ONE passage it came from — the anchor the merger
 *  stamps into message-granular provenance. Notes have no passages. */
export const SESSION_MESSAGE_ID_RULE =
	"For each new proposition, copy the message ID of the passage that most directly states or explains it into messageId.";

export const SESSION_PREAMBLE =
	"You are the extraction stage of a learning application. You read one stretch of a source — a teaching " +
	"session, rendered as the teacher's prose in reading order — and report what it teaches as findings " +
	"for the learner's global knowledge graph, building on everything already extracted from this source.";

export const NOTES_PREAMBLE =
	"You are the extraction stage of a learning application. You read one stretch of a source — the " +
	"author's personal notes, rendered in reading order — and report what it teaches as findings for the " +
	"learner's global knowledge graph, building on everything already extracted from this source.";

export const EXTRACTION_CORE = `THE GOAL: uncover the source's CORE IDEAS and show how everything derives from the foundations. The
source teaches by arguing — ideas worked out from other ideas, down to a foundation the rest stands on.
Your deliverable is twofold: the core ideas themselves, and the chains of reasoning that derive them.
Each chain is premises that JOINTLY entail a conclusion. Entailment is the only link that earns a
chain — where the real connection is historical or narrative (who argued what, how a debate or
exposition unfolds), there is no chain; keep the pieces as bare ideas or drop them. The direction of
the graph is upward: foundational ideas at the bottom, derived ideas above them, each chain showing
how its conclusion follows from what is more established — do not submit connections that carry no
derivation.

The graph holds TRUE ideas about the world, nothing else — never anything about the learner, the
teacher, or this reading: not "the learner understands X" but X. A misconception enters as its TRUE
correction. Each statement is one self-contained idea at full precision.

Extract the load-bearing ideas of the subject — what a reference on it would teach — not the full run
of the discourse. An idea earns its place only when the source's arguments run through it — examples,
notation glosses, and restatements that no argument needs are not core ideas. Every idea must stand
alone for a reader who never saw this source: names and statements may not lean on the source's own
scaffolding (claim numbering, axiom tags, arc labels); a claim that only matters as part of how this
document is organized is not knowledge — drop it.

When the prompt carries THE GRAPH SO FAR, you are continuing a source already partly extracted: build
on it. Reference an existing idea by its id ("n_…") instead of restating it, and prefer chains that
lean on established conclusions as premises — derive new material from what is already derived. Do
not re-derive a conclusion the graph already holds unless the route is genuinely different.

SUBMIT with one submit_findings call: every NEW core idea with a short name and a precise statement,
and every chain as premises + conclusion. A chain's premises and conclusion may be ids from this
submission OR existing ids from THE GRAPH SO FAR, verbatim. Premises within one chain are used
TOGETHER — independent arguments for the same conclusion are separate chains. A conclusion may
reappear, by id, as a premise of later chains. A bare idea that no argument uses rides the
propositions list alone. Include every field even when empty — "chains": [] when the source makes no
arguments. The tool's field descriptions carry the details.`;

export const EXTRACTOR_INSTRUCTIONS = `${SESSION_PREAMBLE}\n\n${EXTRACTION_CORE}\n\n${SESSION_MESSAGE_ID_RULE}`;
export const NOTES_EXTRACTOR_INSTRUCTIONS = `${NOTES_PREAMBLE}\n\n${EXTRACTION_CORE}`;

// ── the same-source digest ──
//
// The extractor is the assembler when it can see what its source has
// already yielded (owner decision: no separate post-hoc assembly stage).
// "" when the source owns nothing yet (the first stretch runs bare). Ids
// ride VERBATIM — that is what the extractor references in its chains
// (the merger's mixed-namespace resolution passes them through).
export function sourceDigest(graph: DerivedGraph, sourceId: string): string {
	const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));
	const ours = graph.nodes.filter((n) => n.provenance.some((pt) => pt.chatId === sourceId));
	const ourChains = graph.chains.filter((c) => c.provenance.some((pt) => pt.chatId === sourceId));
	if (ours.length === 0 && ourChains.length === 0) return "";
	const lines: string[] = [];
	lines.push("THE GRAPH SO FAR — everything already extracted from this source (reference these ids verbatim):");
	for (const n of ours) lines.push(`  ${n.id} | ${n.name} | ${n.statement.replace(/\s+/g, " ")}`);
	if (ourChains.length > 0) {
		lines.push("DERIVATIONS ALREADY RECORDED (build on these; do not re-derive them):");
		for (const c of ourChains) {
			const names = c.premises.map((p) => nameOf.get(p) ?? p).join(" ∧ ");
			lines.push(`  [${c.premises.join(" + ")} ⇒ ${c.conclusion}]  ${names} ⇒ ${nameOf.get(c.conclusion) ?? c.conclusion}`);
		}
	}
	return lines.join("\n");
}

/** The extractor over one unit of a source. A chat batch submits
 *  session findings whose every messageId must name one of `anchors` (the
 *  batch's teacher-prose ids, checked at the submit seam); a notes chunk
 *  submits the base wire, with no passages to anchor to. */
function runExtractor(
	kind: "chat" | "notes",
	engine: PiEngine | undefined,
	sourceId: string,
	prompt: string,
	existingIds: ReadonlySet<string>,
	anchors: ReadonlySet<string> | undefined,
	signal: AbortSignal | undefined,
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void,
): Promise<SessionFindings> {
	return runSubmitAgent<SessionFindings>({
		role: "extractor",
		variant: kind === "chat" ? "session-findings" : "notes-findings",
		// The durable owner is the source (the chat id / notes src id); the
		// run key is deterministic, so a retried batch reattaches its
		// conversation instead of billing another copy.
		run: { chatId: sourceId, jobId: submitRunKey("extract", sourceId, prompt) },
		existingIds: [...existingIds],
		...(anchors ? { batchIds: [...anchors] } : {}),
		systemPrompt: kind === "chat" ? EXTRACTOR_INSTRUCTIONS : NOTES_EXTRACTOR_INSTRUCTIONS,
		prompt,
		engine,
		signal,
		onStep,
		neverSubmitted: "the extractor never submitted findings",
	});
}

// ─── the auditor ───────────────────────────────────────────────────────────

const AUDITOR_INSTRUCTIONS = `You are the linking stage of a learning application's extraction pipeline. An extractor
has read a source (a teaching session, or the author's personal notes) and reported findings: propositions and
their reasoning chains. You NEVER see the source itself — the extractor is fully trusted, and you do not re-check
its work. Your job is IDENTITY: connecting those findings to the CURRENT knowledge graph, preparing the merge.

You explore the graph through your tools: list_sessions, list_propositions, and find (glob over names +
statements + aliases; each hit also says which session it was born in). The graph is SMALL and FINITE — a handful of
sessions — and your job is done as soon as you have SEEN the plausible candidates. FOLLOW THIS PROCEDURE:

1. GROUND yourself first: call list_sessions ONCE. This one call shows the entire space — every session that ever
   contributed propositions, and how many. Now you know the extent of what you are searching; nothing is hidden.
2. READ the plausibly-related sessions: for each session whose topic could overlap these findings, call
   list_propositions — every proposition born there, with full statement text. A few calls and you have read
   every realistic identity candidate in the graph.
3. find is your targeted sweep: use it for phrasings, synonyms, and neighboring ideas the session reads made you
   wonder about — its hits point back at sessions you can read whole.
4. SUBMIT. Once every plausibly-related session has been read (and stray finds come back empty), you are DONE.
   Do not re-search ground you have already seen; more patterns over the same nodes are wasted work.

IDENTITY — links, per proposition:
- For each proposition: does an EXISTING node — one you have now SEEN — already state this same proposition?
- If yes: add { "id": <its proposition id>, "linkTo": <that node's id> } to "links". The session's phrasings join
  its aliases and its provenance; the node keeps its existing name.
- If no: add nothing — a new node is created with the extractor's name as its label.
- EQUIVALENCE BIAS (owner ruling): paraphrases, rewordings, and compressions of the same claim MERGE. When two
  statements are the same claim at different precision or from different angles, LINK them. Only genuinely distinct
  propositions — different claims about the world — stay apart. You are NOT guarding against wrong merges; you are
  hunting for right ones.

Your deliverable is ONLY the identity verdicts: "links". NEVER restate the propositions —
the merger already has them. You NEVER create relations between propositions — they come from the
extractor alone, and the batch connects to the existing graph ONLY through the equivalences you identify. Your
entire deliverable is ONE submit_review call.

Include the "links" field even when empty — "links": [] when nothing links. NEVER omit it because it is empty.`;

/** The auditor — one shape for both front doors. An agentic loop:
 *  graph-exploration tools plus the one submit call. */
function runAuditor(
	engine: PiEngine | undefined,
	sourceId: string,
	prompt: string,
	signal: AbortSignal | undefined,
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void,
	graph: GraphDeps,
): Promise<AuditVerdicts> {
	return runSubmitAgent({
		role: "auditor",
		variant: "audit",
		run: { chatId: sourceId, jobId: submitRunKey("audit", sourceId, prompt) },
		existingIds: [],
		systemPrompt: AUDITOR_INSTRUCTIONS,
		prompt,
		engine,
		signal,
		onStep,
		neverSubmitted: "the auditor never submitted a review",
		maxTurns: 16,
		graph,
	});
}

/** The durable run identity of one submit stage: the source plus a digest of
 *  the exact prompt. The same logical stage (same source, same rendered
 *  stretch/digest) reattaches its conversation across process deaths; a new
 *  prompt is a new run. */
function submitRunKey(stage: "extract" | "audit", sourceId: string, prompt: string): string {
	return `${stage}:${sourceId}:${crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16)}`;
}

// ─── the pipeline status registry ─────────────────────────────────────────────

/** The pipeline phases tell the truth about what the job is waiting on.
 *  "queued": waiting for a slot of the shared background-LLM pool, not
 *  for the model. "waiting": the extractor is done but the job's
 *  audit+merge critical section is queued behind another job's. */

/** One in-flight pipeline run. Module-level: one process, one registry.
 *  Exported for the status payload's consumer typing (the dock). */
export interface RunningExtraction {
	/** The registry key: the source id, plus "#i" for a chunk job. */
	id: string;
	/** The SOURCE id (chat id / notes src id) — the payload's identity and
	 *  the abort key. The registry KEY adds "#i" for chunk jobs (a
	 *  multi-chunk source owns several entries); this field stays the
	 *  source id so the feed's reveal logic and abort stay source-scoped. */
	chatId: string;
	/** Which chunk of how many this job is — present only when the source fanned out (n > 1). Drives
	 *  the feed row's "· i/N" suffix. */
	part?: { i: number; n: number };
	/** Which front door the run came through — label + usage-persistence
	 *  depend on it (chats bill their chat record; notes bill the source
	 *  record). */
	kind: "chat" | "notes";
	/** Display label (the file path for notes imports); the status route
	 *  falls back to the chat store for chat runs. */
	label?: string;
	phase: ExtractionPhase;
	startedAt: number;
	/** Live per-stage usage, accumulated as steps bill (the dock's cost /
	 *  context-window blobs read this through /api/graph/status). */
	usage: {
		extractor?: ExtractionStageUsage;
		auditor?: ExtractionStageUsage;
	};
	/** True-cancellation handle (the dock's abort button): one controller per
	 *  run, shared across phases; abort() cancels the in-flight model call. */
	controller: AbortController;
}

interface ExtractionRuns {
	/** In-flight pipeline runs, keyed chatId (chat) / src id (notes). */
	running: Map<string, RunningExtraction>;
	/** The single-flight guard, shared by every pipeline instance: each
	 *  admitted run's settle promise, by chat/source id. */
	inFlight: Map<string, Promise<unknown>>;
	/** Last minted startedAt — kept monotonic so two runs starting in the
	 *  same millisecond never collide on the usage idempotency key. */
	lastStartedAt: number;
	/** Runs that are admitted but have not reached their first phase yet
	 *  (the durable record read is awaited): abort must still cancel them
	 *  synchronously, or a hanging provider call could never be stopped. */
	early?: Map<string, AbortController>;
}

function runs(): ExtractionRuns {
	return processState<ExtractionRuns>("extractionRuns", () => ({ running: new Map(), inFlight: new Map(), lastStartedAt: 0 }));
}

/** In-flight pipeline runs (oldest first) — the /api/graph/status payload. */
export function extractionStatuses(): RunningExtraction[] {
	return [...runs().running.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** True cancellation of the in-flight run for a chat (the dock's abort
 *  button): the pending model call receives the signal — the provider
 *  cancels the request, spend stops. The in-flight unit merges nothing;
 *  earlier merged units stay covered; partial usage is still persisted.
 *  Returns false when no run is in flight (idempotent no-op). */
export function abortExtraction(chatId: string): boolean {
	// A source may own several registry entries (one per chunk/batch) —
	// aborting the source aborts EVERY job of its fan-out.
	let found = false;
	const early = runs().early?.get(chatId);
	if (early) {
		early.abort();
		found = true;
	}
	for (const run of runs().running.values()) {
		if (run.chatId !== chatId) continue;
		run.controller.abort();
		found = true;
	}
	return found;
}

/** Abort the chat's run and wait until it has wound down (nothing merges
 *  after this settles). Resolves at once when nothing runs. */
export async function stopExtraction(chatId: string): Promise<void> {
	abortExtraction(chatId);
	await runs().inFlight.get(chatId)?.catch(() => undefined);
}
// ─── the pipeline ───────────────────────────────────────────────────────────

interface ExtractionJob {
	key: string;
	sourceId: string;
	kind: "chat" | "notes";
	label?: string;
	part?: { i: number; n: number };
}

/** One unit a source is extracted in (a chat batch, a notes chunk). */
interface SourceUnit {
	view: string;
	/** Chat batches: the teacher-prose ids propositions may anchor to. */
	anchors?: ReadonlySet<string>;
	/** Chat batches: the coverage rows the merge checkpoints. */
	coverage?: (foldedAt: string) => CoverageEntry[];
}

/** What one extraction run walks, unit by unit, in order. */
interface ExtractionSource {
	id: string;
	kind: "chat" | "notes";
	label?: string;
	units: SourceUnit[];
	/** The merge stamp; absent = the merge time. */
	foldedAt?: string;
	/** Throws an AbortError when the source vanished mid-run. */
	assertPresent?: () => Promise<void>;
}


interface ExtractionModels {
	/** Settings-resolved engine per role, read FRESH per stage call (a
	 *  settings PUT between stages lands). BYOK: the chain (role override →
	 *  slot → nothing) may end EMPTY → undefined; the front doors refuse
	 *  with ModelsNotConfiguredError before any stage runs. */
	engineFor: (role: ModelRole) => PiEngine | undefined;
	/** Key-presence gate: given a stage engine's provider + the role's slot
	 *  tier, returns the refusal envelope when the provider's key is missing
	 *  (null = run). A keyless stage refuses with ProviderKeyMissingError
	 *  BEFORE any batch runs. */
	providerKeyMissing: (provider: string, slots: ModelSlotName[]) => ProviderKeyMissing | null;
}

export interface ExtractionPipelineDeps extends GraphDeps, ExtractionModels {
	/** The chunk budget — the transcript-token share of the extractor's
	 *  context; batches fill to it (the trigger fires on the same number,
	 *  read fresh per run). */
	getChunkTokens: () => number;
}

interface NotesImportInput {
	/** The source's file path — its identity (deterministic src id) AND its
	 *  provenance label in the detail card. */
	filePath: string;
	/** The file's raw content, VERBATIM — any format. */
	text: string;
}

/** A notes import did not finish. Earlier graph writes and billed usage are
 * retained; partialStats describe known merges, not an all-or-nothing result. */
export class NotesImportError extends Error {
	constructor(
		public readonly outcome: "failed" | "partial" | "aborted" | "busy",
		public readonly partialStats: EmissionStats,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "NotesImportError";
	}
}

export interface ExtractionPipeline {
	/** Extract + audit + merge ONE chat. Single-flight per chat; resolves to
	 *  the merger's append stats. */
	runExtraction(chatId: string): Promise<EmissionStats>;
	/** Is a chat run admitted (runExtraction would be a no-op)? */
	isRunning(chatId: string): boolean;
	/** Why a run would be refused right now (no model for a stage, or a
	 *  stage's provider key missing), or null when it can run. */
	refusal(): ModelsNotConfigured | ProviderKeyMissing | null;
	/** The format-agnostic front door: run the same pipeline
	 *  over ONE raw notes file. The source id is deterministic per file
	 *  path, so re-importing the same file re-runs extraction against the
	 *  same source identity (mappings dedupe by it). */
	importNotes(input: NotesImportInput): Promise<EmissionStats>;
	/** Import several files, as many at once as the LLM pool runs. Each
	 *  file's text is read when its turn comes; `onSettled` reports each
	 *  outcome as it lands. Resolves to the outcomes in input order. */
	importNotesFiles(
		files: NotesFile[],
		onSettled?: (index: number, outcome: PromiseSettledResult<EmissionStats>) => void,
	): Promise<PromiseSettledResult<EmissionStats>[]>;
}

export interface NotesFile {
	filePath: string;
	text: () => Promise<string> | string;
}

export function createExtractionPipeline(deps: ExtractionPipelineDeps): ExtractionPipeline {
	const { chatStore, graphStore } = deps;
	const stageEngine = (role: ModelRole): PiEngine | undefined => deps.engineFor(role);
	/** Refuses BEFORE any batch runs when a stage has no model or a
	 *  configured stage's provider key is gone. */
	function refuseIfStagesUnready(): void {
		const stages: readonly [ModelRole, PiEngine | undefined][] = [
			["extractor", stageEngine("extractor")],
			["auditor", stageEngine("auditor")],
		];
		const missing = new Set<ModelSlotName>();
		for (const [role, engine] of stages) if (!engine) missing.add(ROLE_SLOT[role]);
		if (missing.size > 0) {
			console.info(`[extraction] refused — no model configured for: ${[...missing].join(", ")}`);
			throw new ModelsNotConfiguredError([...missing]);
		}
		// Key-presence parity: first offender surfaces (extractor before
		// auditor); fixing that key re-gates and the next run surfaces the
		// next offender, if any.
		for (const [role, engine] of stages) {
			const refusal = deps.providerKeyMissing(engine!.model.provider, [ROLE_SLOT[role]]);
			if (refusal) {
				console.info(`[extraction] refused — ${JSON.stringify(refusal)}`);
				throw new ProviderKeyMissingError(refusal.provider, refusal.slots);
			}
		}
	}
	const runningExtractions = runs().running;
	const inFlight = runs().inFlight;

	function setPhase(job: ExtractionJob, phase: ExtractionPhase): void {
		const R = runs();
		const prev = runningExtractions.get(job.key);
		if (!prev) R.lastStartedAt = Math.max(Date.now(), R.lastStartedAt + 1);
		runningExtractions.set(job.key, {
			id: job.key,
			chatId: job.sourceId,
			part: job.part,
			kind: job.kind,
			label: job.label,
			phase,
			startedAt: prev?.startedAt ?? R.lastStartedAt,
			usage: prev?.usage ?? {},
			controller: prev?.controller ?? forwardedController(R.early?.get(job.sourceId)),
		});
		// Notify-after-write: the registry is the feed's truth.
		emit("activity-changed", {});
	}

	/** Run over (done, failed, aborted): the row leaves the feed. ONE seam
	 *  for all delete sites so no exit path can miss the announce. */
	function finishExtraction(jobKey: string): void {
		runningExtractions.delete(jobKey);
		emit("activity-changed", {});
	}

	function recordStep(jobKey: string, stage: "extractor" | "auditor", usage: CallUsage, model: string): void {
		const run = runningExtractions.get(jobKey);
		if (!run) return;
		run.usage[stage] ??= { model, steps: [] };
		run.usage[stage]!.steps.push(usage);
	}

	/** SERIALIZED AUDIT: the auditor explores the LIVE
	 *  graph through its tools and stamps identity verdicts against what
	 *  it finds — so the audit+merge section is a process-wide critical
	 *  section. Two concurrent audits would each link into a graph the
	 *  other is about to change: the structural mint of duplicate nodes.
	 *  The extractor stays parallel (source-local, graph-blind). The
	 *  check runs BEFORE any LLM is invoked or the graph read; the lock
	 *  is FIFO, held through the merge, reacquired per batch, and
	 *  abort-aware on both sides of the queue (a waiter that aborts
	 *  leaves without auditing — its chain link still resolves, so
	 *  successors never hang). */
	async function withAuditLock<T>(job: ExtractionJob, critical: () => Promise<T>): Promise<T> {
		setPhase(job, "waiting");
		const jobKey = job.key;
		const lock = processState<{ tail: Promise<void> }>("auditLock", () => ({ tail: Promise.resolve() }));
		const prev = lock.tail;
		let release!: () => void;
		lock.tail = new Promise<void>((resolve) => (release = resolve));
		const signal = runningExtractions.get(jobKey)?.controller.signal;
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<never>((_, reject) => {
			if (!signal) return;
			onAbort = () => {
				reject(abortError("extraction aborted while waiting for the audit gate"));
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			await Promise.race([prev, aborted]);
			signal?.throwIfAborted();
			return await critical();
		} finally {
			if (onAbort && signal && !signal.aborted) signal.removeEventListener("abort", onAbort);
			release();
		}
	}

	async function extract(job: ExtractionJob, unit: SourceUnit): Promise<SessionFindings> {
		const signal = runningExtractions.get(job.key)?.controller.signal;
		signal?.throwIfAborted();
		// Serialized units make this read the post-merge graph of every
		// earlier unit (cross-source runs stay parallel — the digest is
		// source-scoped, so only SAME-source order matters).
		const graph = getGraph(graphStore);
		const digest = sourceDigest(graph, job.sourceId);
		const prompt = digest === "" ? unit.view : `${digest}\n\n${unit.view}`;
		console.info(
			`[extraction ${job.key}] extractor starting (${unit.view.split("\n").length} lines` +
				`${digest === "" ? "" : `, digest ${digest.split("\n").length} lines`})`,
		);
		const t0 = performance.now();
		const findings = await runExtractor(
			job.kind,
			stageEngine("extractor"),
			job.sourceId,
			prompt,
			new Set(graph.nodes.map((n) => n.id)),
			unit.anchors,
			signal,
			(usage, model, step, finishReason, tools) => {
				recordStep(job.key, "extractor", usageFromPi(usage), model);
				console.info(`[extraction] extractor step ${step}: ${finishReason}, tools: ${tools}`);
			},
		);
		console.info(`[extraction ${job.key}] extractor done in ${Math.round(performance.now() - t0)}ms`);
		return findings;
	}

	async function audit(jobKey: string, sourceId: string, findings: SessionFindings): Promise<AuditVerdicts> {
		const signal = runningExtractions.get(jobKey)?.controller.signal;
		signal?.throwIfAborted();
		const graph = getGraph(graphStore);
		console.info(
			`[extraction ${jobKey}] auditor starting (${findings.propositions.length} propositions, ` +
				`${graph.nodes.length} graph nodes)`,
		);
		const t0 = performance.now();

		// The proposition projection omits messageId: the auditor is
		// IDENTITY-only and never sees the passages, so anchors add
		// cognitive load, not signal.
		const auditResult = await runAuditor(
			stageEngine("auditor"),
			sourceId,
			`Proposed findings from the extractor (the source itself is not available to you — the extractor is fully trusted; the propositions only — the reasoning chains are the merger's business, owner 2026-09-30):\n\n` +
				`${JSON.stringify(
					{
						propositions: findings.propositions.map((p) => ({
							id: p.id,
							name: p.name,
							statement: p.statement,
							aliases: p.aliases,
						})),
					},
					null,
					2,
				)}\n\n` +
				`The current knowledge graph has ${graph.nodes.length} node(s). Explore it with your tools and link what links.`,
			signal,
			(usage, model, step, finishReason, tools) => {
				recordStep(jobKey, "auditor", usageFromPi(usage), model);
				console.info(`[extraction] auditor step ${step}: ${finishReason}, tools: ${tools}`);
			},
			{ chatStore, graphStore },
		);
		console.info(
			`[extraction ${jobKey}] audit: ${findings.propositions.length} propositions through, ` +
				`${auditResult.links.length} linked to existing nodes`,
		);
		console.info(`[extraction ${jobKey}] auditor done in ${Math.round(performance.now() - t0)}ms`);
		return auditResult;
	}

	/** Extraction jobs run under the shared background-LLM pool
	 *  (llm-slots.ts); the job's registry-row signal kills a queued ticket.
	 *  The audit side needs no slot: audits serialize behind their own lock. */
	async function withExtractSlot<T>(jobKey: string, critical: () => Promise<T>): Promise<T> {
		const signal = runningExtractions.get(jobKey)?.controller.signal;
		return withBgLlmSlot(signal, critical);
	}

	/** Append the run's usage record to the chat's extractions log — success
	 *  or failure: a failed run still spent money, and its partial usage is
	 *  exactly what the record should show (stats absent = never merged).
	 *  Idempotent per startedAt (the store dedupes). */
	async function persistRunUsage(jobKey: string, durationMs: number, stats: EmissionStats | undefined): Promise<void> {
		const run = runningExtractions.get(jobKey);
		if (!run) return;
		// The usage ledgers key by SOURCE (run.chatId), not the "#i" job key.
		// A chat deleted mid-run has no usage log to append to — its partial
		// spend goes with it (appendSourceUsage already no-ops for a vanished
		// source; the chat path guards here).
		if (run.kind === "chat" && !(await chatStore.getChat(run.chatId))) return;
		const entry: ExtractionRunUsage = {
			startedAt: run.startedAt,
			at: new Date().toISOString(),
			durationMs,
			stats,
			stages: {
				extractor: run.usage.extractor ?? { model: "unknown", steps: [] },
				auditor: run.usage.auditor ?? { model: "unknown", steps: [] },
			},
		};
		if (run.kind === "notes") graphStore.appendSourceUsage(run.chatId, entry);
		else await chatStore.appendExtractionUsage(run.chatId, entry);
	}

	/** One chunk/batch JOB: the registry
	 *  entry's lifecycle — minted with its part, usage persisted per job
	 *  (the ledger shows each chunk's cost), removed on any exit. The body
	 *  runs the full queued → extract → audit-locked merge lifecycle;
	 *  failure isolation lives at the fan-out site (one bad chunk never
	 *  kills its siblings). */
	async function runJob(job: ExtractionJob, body: () => Promise<EmissionStats>): Promise<EmissionStats> {
		const jobKey = job.key;
		const t0 = performance.now();
		try {
			const stats = await body();
			await persistRunUsage(jobKey, Math.round(performance.now() - t0), stats);
			return stats;
		} catch (err) {
			await persistRunUsage(jobKey, Math.round(performance.now() - t0), undefined);
			throw err;
		} finally {
			finishExtraction(jobKey);
		}
	}

	/** The fan-out aggregation: successes
	 *  count (earlier chunks keep their merges — checkpoints make aborts
	 *  cheap), aborts log and pass as partial stats, isolated failures log
	 *  per job and never throw — the source's run returns what actually
	 *  merged. */
	function aggregateJobs(sourceId: string, settled: PromiseSettledResult<EmissionStats>[]): EmissionStats {
		const stats: EmissionStats = { nodes: 0, chains: 0 };
		let aborted = false;
		let failed = 0;
		for (const result of settled) {
			if (result.status === "fulfilled") {
				stats.nodes += result.value.nodes;
				stats.chains += result.value.chains;
				// ABSENT when nothing dropped (tests deep-equal the stats).
				if (result.value.droppedChains)
					stats.droppedChains = (stats.droppedChains ?? 0) + result.value.droppedChains;
				continue;
			}
			const err = result.reason;
			if (isAbortError(err)) aborted = true;
			else {
				failed++;
				console.error(`[extraction ${sourceId}] job failed (isolated):`, err);
			}
		}
		if (aborted)
			console.info(
				`[extraction ${sourceId}] aborted — merged chunks keep their coverage, the rest stay uncovered for the next run`,
			);
		if (failed > 0)
			console.error(`[extraction ${sourceId}] ${failed} job(s) failed; successful jobs still merged`);
		return stats;
	}

	/** A job's abort controller, forwarding an abort that landed while the run
	 *  was still awaiting its first record read. */
	function forwardedController(parent: AbortController | undefined): AbortController {
		const controller = new AbortController();
		if (!parent) return controller;
		if (parent.signal.aborted) controller.abort();
		else parent.signal.addEventListener("abort", () => controller.abort(), { once: true });
		return controller;
	}

	/** PER-UNIT JOBS, SERIALIZED PER SOURCE: each unit is its own job — registry row, usage
	 *  record — and runs queued → extract slot → audit-locked merge →
	 *  settle, strictly in order, each extractor continuing the source's
	 *  digest. Cross-source runs stay parallel; the extract semaphore caps
	 *  concurrent extracts; audits serialize process-wide. A failed unit is
	 *  ISOLATED (it stays uncovered, honestly re-runnable) and its siblings
	 *  keep merging; an abort ends the whole run. `merged` counts every
	 *  committed merge, even one whose later layout or usage step failed. */
	async function runSource(source: ExtractionSource): Promise<{ settled: PromiseSettledResult<EmissionStats>[]; merged: EmissionStats }> {
		const settled: PromiseSettledResult<EmissionStats>[] = [];
		const merged: EmissionStats = { nodes: 0, chains: 0 };
		for (const [index, unit] of source.units.entries()) {
			const part = source.units.length > 1 ? { i: index + 1, n: source.units.length } : undefined;
			const job: ExtractionJob = { key: part ? `${source.id}#${part.i}` : source.id, sourceId: source.id, kind: source.kind, label: source.label, part };
			// Keep the job's signal past runJob's teardown: a usage-persistence
			// failure can mask the body's AbortError.
			let signal: AbortSignal | undefined;
			try {
				const stats = await runJob(job, async () => {
					setPhase(job, "queued");
					signal = runningExtractions.get(job.key)?.controller.signal;
					const findings = await withExtractSlot(job.key, async () => {
						setPhase(job, "extracting");
						return extract(job, unit);
					});
					return withAuditLock(job, async () => {
						setPhase(job, "auditing");
						const verdicts = await audit(job.key, source.id, findings);
						setPhase(job, "merging");
						await source.assertPresent?.();
						const foldedAt = source.foldedAt ?? new Date().toISOString();
						const stats = mergeFindings(source.id, findings, verdicts, { chatStore, graphStore }, {
							foldedAt,
							...(unit.coverage ? { coverage: unit.coverage(foldedAt) } : {}),
						});
						merged.nodes += stats.nodes;
						merged.chains += stats.chains;
						if (stats.droppedChains) merged.droppedChains = (merged.droppedChains ?? 0) + stats.droppedChains;
						// Sync: the next snapshot fetch must already reflect the new nodes.
						settleGraphLayout(graphStore);
						console.info(`[extraction ${job.key}] merged: ${stats.nodes} nodes, ${stats.chains} chains`);
						return stats;
					});
				});
				settled.push({ status: "fulfilled", value: stats });
			} catch (err) {
				let failure = err;
				if (signal?.aborted && !isAbortError(err)) {
					failure = abortError(`Extraction aborted; job cleanup failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
				}
				settled.push({ status: "rejected", reason: failure });
				if (isAbortError(failure)) break;
			}
		}
		return { settled, merged };
	}

	function runExtraction(chatId: string): Promise<EmissionStats> {
		if (inFlight.has(chatId)) return Promise.resolve({ nodes: 0, chains: 0 });
		const run = extractChat(chatId).finally(() => inFlight.delete(chatId));
		inFlight.set(chatId, run);
		return run;
	}

	async function extractChat(chatId: string): Promise<EmissionStats> {
		// Admitted-but-unphased: the record read below is awaited, so an abort
		// arriving in that window must still land (the dock's abort button and
		// the deletion wind-down both fire immediately after dispatch).
		const early = new AbortController();
		const earlyMap = (runs().early ??= new Map());
		earlyMap.set(chatId, early);
		const t0 = performance.now();
		// COVERAGE: extract ONLY what the per-chat coverage ledger doesn't
		// already hold. Each merged batch checkpoints its messages' coverage
		// ATOMICALLY inside the merge, so an abort or error below loses at
		// most the in-flight batch — every earlier batch stays covered, the
		// rest stays visibly uncovered.
		try {
			const record = await chatStore.getChat(chatId);
			if (!record) throw new Error(`Chat not found: ${chatId}`);
			// Typed refusal: the trigger skips, routes surface 503.
			refuseIfStagesUnready();
			const covered = coverageOf(record.messages, graphStore.readCoverage(), chatId);
			if (covered.uncovered.length === 0) {
				console.info(`[extraction ${chatId}] nothing uncovered — no-op`);
				return { nodes: 0, chains: 0 };
			}
			const chunkTokens = deps.getChunkTokens();
			const batches = batchRuns(covered.slots, covered.uncovered, chunkTokens);
			console.info(
				`[extraction ${chatId}] pipeline start — ${covered.uncoveredTokens} uncovered tok, ` +
					`${covered.uncoveredCount} messages, ${batches.length} batch(es) of ≤${chunkTokens} tok`,
			);
			const { settled } = await runSource({
				id: chatId,
				kind: "chat",
				units: batches.map((batch) => {
					const prose = batch.filter((slot) => messageViewLines(slot.message, slot.message.id).length > 0);
					return {
						view: proseView(batch.map((slot) => slot.message), record.title),
						anchors: new Set(prose.map((slot) => slot.message.id)),
						// Snapshotted when the run computed coverage — a message that
						// mutates mid-run re-opens (its fingerprint no longer matches).
						coverage: (foldedAt) => prose.map((slot) => ({ chatId, fp: slot.fp, tokens: slot.tokens, foldedAt })),
					};
				}),
				// SESSION-DELETION GUARD: a chat deleted mid-run never
				// merges — a run that slipped past the wind-down finds the chat
				// gone here and rides the abort path.
				assertPresent: async () => {
					if (await chatStore.getChat(chatId)) return;
					throw abortError(`chat deleted mid-run: ${chatId}`);
				},
			});
			const stats = aggregateJobs(chatId, settled);
			console.info(
				`[extraction ${chatId}] merged: ${stats.nodes} nodes, ${stats.chains} chains ` +
					`(${Math.round(performance.now() - t0)}ms total, ${batches.length} batch job(s))`,
			);
			return stats;
		} catch (err) {
			// Pre-fan-out failures only (stage gate, coverage read): aborts
			// and job-level failures are absorbed at the fan-out site, per
			// job — merged batches stay covered, partial usage persists per
			// job, the aggregate returns what actually merged.
			console.error(`[extraction ${chatId}] pipeline failed (${Math.round(performance.now() - t0)}ms):`, err);
			throw err;
		} finally {
			earlyMap.delete(chatId);
			finishExtraction(chatId);
		}
	}

	// ── the notes front door (format-agnostic: raw text in, same graph out) ──

	/** The raw source view the notes stages see: the file path + the text
	 *  VERBATIM. No message ids — provenance is the file itself. */
	function notesView(input: { filePath: string; text: string; part?: { i: number; n: number } }): string {
		const part = input.part && input.part.n > 1 ? ` (part ${input.part.i}/${input.part.n})` : "";
		return `SOURCE (the author's personal notes): ${input.filePath}${part}\n\n${input.text}`;
	}

	/** Chunk the notes text under the same budget the chat path uses (a
	 * whole file in one call collapses weak models). Greedy by line; a
	 * single over-budget line rides alone (never split a line). */
	function chunkNotes(text: string, budget: number): string[] {
		if (text.trim().length === 0) return [];
		const out: string[] = [];
		let current = "";
		for (const line of text.split("\n")) {
			const candidate = current.length === 0 ? line : current + "\n" + line;
			if (current.length > 0 && tokensForChars(candidate.length) > budget) {
				out.push(current);
				current = line;
			} else {
				current = candidate;
			}
		}
		if (current.trim().length > 0) out.push(current);
		return out;
	}

	async function runNotesExtraction(input: { id: string; filePath: string; text: string; importedAt: string }): Promise<EmissionStats> {
		const { id } = input;
		// importNotes owns the source exclusion, including metadata and cleanup.
		const t0 = performance.now();
		let mergedStats: EmissionStats = { nodes: 0, chains: 0 };
		try {
			refuseIfStagesUnready();
			// Abort mid-run keeps earlier chunks merged, like chat batches.
			const chunkTokens = deps.getChunkTokens();
			const chunks = chunkNotes(input.text, chunkTokens);
			console.info(
				`[extraction ${id}] notes pipeline start (${input.filePath}) — ${chunks.length} chunk(s) of ≤${chunkTokens} tok`,
			);
			const { settled, merged } = await runSource({
				id,
				kind: "notes",
				label: input.filePath,
				foldedAt: input.importedAt,
				units: chunks.map((chunk, index) => ({
					view: notesView({ filePath: input.filePath, text: chunk, part: chunks.length > 1 ? { i: index + 1, n: chunks.length } : undefined }),
				})),
			});
			mergedStats = merged;
			const stats = aggregateJobs(id, settled);
			// Completion is a chunk-status contract, never a node-count test.
			// Zero findings (and an empty file after the readiness gate) are valid.
			const rejected = settled.filter((r) => r.status === "rejected");
			if (rejected.length > 0 || settled.length !== chunks.length) {
				const aborted = rejected.some((r) => isAbortError(r.reason));
				const outcome = aborted ? "aborted" : settled.some((r) => r.status === "fulfilled") ? "partial" : "failed";
				const details = rejected.map((r) => r.reason instanceof Error ? r.reason.message : String(r.reason)).join("; ");
				throw new NotesImportError(outcome, mergedStats, details || "Notes import did not complete");
			}
			console.info(
				`[extraction ${id}] merged: ${stats.nodes} nodes, ${stats.chains} chains ` +
					`(${Math.round(performance.now() - t0)}ms total, ${chunks.length} chunk job(s))`,
			);
			return stats;
		} catch (err) {
			console.error(`[extraction ${id}] notes pipeline failed (${Math.round(performance.now() - t0)}ms):`, err);
			if (err instanceof NotesImportError || err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) throw err;
			throw new NotesImportError(isAbortError(err) ? "aborted" : "failed", mergedStats,
				err instanceof Error ? err.message : String(err), { cause: err });
		} finally {
			finishExtraction(id);
		}
	}

	/** Every explicit import processes the whole file. Identity, source digest,
	 * auditor and usage history remain source-scoped; this is not exactly-once. */
	async function importNotes(input: NotesImportInput): Promise<EmissionStats> {
		const id = `src_${crypto.createHash("sha256").update(input.filePath).digest("hex").slice(0, 12)}`;
		// Acquire BEFORE source upsert: overlapping contents must not alter metadata.
		if (inFlight.has(id)) throw new NotesImportError("busy", { nodes: 0, chains: 0 }, "This file is already being imported. Try again when it finishes.");
		let settle!: () => void;
		inFlight.set(id, new Promise<void>((resolve) => (settle = resolve)));
		try {
			const importedAt = new Date().toISOString();
			graphStore.upsertSource({ id, filePath: input.filePath, importedAt });
			return await runNotesExtraction({ id, ...input, importedAt });
		} catch (err) {
			if (err instanceof NotesImportError || err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) throw err;
			throw new NotesImportError("failed", { nodes: 0, chains: 0 }, err instanceof Error ? err.message : String(err), { cause: err });
		} finally {
			inFlight.delete(id);
			settle();
		}
	}

	async function importNotesFiles(
		files: NotesFile[],
		onSettled?: (index: number, outcome: PromiseSettledResult<EmissionStats>) => void,
	): Promise<PromiseSettledResult<EmissionStats>[]> {
		const outcomes: PromiseSettledResult<EmissionStats>[] = [];
		let next = 0;
		const worker = async () => {
			while (next < files.length) {
				const index = next++;
				const file = files[index]!;
				try {
					outcomes[index] = { status: "fulfilled", value: await importNotes({ filePath: file.filePath, text: await file.text() }) };
				} catch (reason) {
					outcomes[index] = { status: "rejected", reason };
				}
				onSettled?.(index, outcomes[index]);
			}
		};
		await Promise.all(Array.from({ length: Math.min(BG_LLM_PERMITS, files.length) }, worker));
		return outcomes;
	}

	function refusal(): ModelsNotConfigured | ProviderKeyMissing | null {
		try {
			refuseIfStagesUnready();
			return null;
		} catch (error) {
			if (error instanceof ModelsNotConfiguredError || error instanceof ProviderKeyMissingError) return error.envelope;
			throw error;
		}
	}

	return { runExtraction, isRunning: (chatId) => inFlight.has(chatId), refusal, importNotes, importNotesFiles };
}

