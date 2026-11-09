/**
 * THE NATIVE MESSAGE RECORD (Wave B, owner-approved 2026-09-26): chat
 * records store pi's own message shapes — the exact history the agent
 * loop builds — instead of AI-SDK UIMessages. Provider, model, usage,
 * stopReason, and thinking signatures are stamped by pi itself; replay is
 * `state.messages = record.messages` + `continue()` — the record IS the
 * agent state.
 *
 * WHY pi MESSAGES LACK OUR `id`: pi's session format gives every ENTRY an
 * id, never the message. This app needs a per-message id for client
 * identity (render keys, append-only adoption, the continuation seam), so
 * every record message carries ONE extra field — `id` — alongside the
 * native shape. `wireOf` strips it at the wire: the provider never
 * sees it.
 *
 * UI-ONLY CONTENT (owner ruling, fork 1 + the plan's custom-message
 * taxonomy): the probe→teach handoff, sub-agent steers,
 * and plan blocks are LhMarkerMessage — this app's custom role, shaped
 * exactly like pi's own CustomMessage ({role:"custom", customType,
 * content, display, details}). wireOf decides what each one shows the
 * model (markers flatten to their user text, UI-only markers show
 * nothing) and compactionCutOf decides which messages a request skips;
 * the durable entry writes and the request filter both use them.
 *
 * Answers (fork 1, owner 2026-09-26): the learner's answer IS the tool
 * call's ToolResultMessage — appended natively at answer time. The
 * synthetic "question posed" placeholder is an in-memory loop device
 * (Wave A's terminate) and is never persisted: the record ends at the
 * unanswered call in the pose→answer window, where no turn can run (the
 * question gate holds steers; a POST would 409).
 */

import { mintId } from "../../platform/model/index.ts";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { isQuestionTool } from "../../tools/model/index.ts";
import {
	CONCLUDE_ACK_TEXT,
	HANDOFF_TEXT,
	NEXT_PROBLEM_TEXT,
	THINKING_LABEL,
} from "./types.ts";
import { compactAnswerForModel, type QuestionAnswerData } from "./questions.ts";
import { activeCompactionOf, keptIndexFor } from "./compaction.ts";

/** The hard-invariant wording for an aborted turn's unanswered calls —
 *  carried over verbatim from the pre-native era so the model's view
 *  never drifted. */
export const INTERRUPTED_TEXT =
	"The question was interrupted — the learner never answered; continue without holding a result for it.";

// ─── The record's message type ───────────────────────────────────────────────

/**
 * The app's custom message. Shaped like a native message —
 * `content` is the MODEL-facing text (single-sourced in core/contracts,
 * never fake human speech), `details` is the UI payload (never
 * model-visible), `display` marks messages the UI renders (our projection
 * keys rendering on customType; the flag documents intent).
 */
export interface LhMarkerMessage {
	/** Record identity (pi messages carry no id — see the file header). */
	id: string;
	role: "custom";
	customType:
		| "graph-context"
		| "probe-handoff"
		| "subagent-steer"
		| "subagent-abort"
		| "plan-block"
		| "practice-thinking"
		| "practice-next"
		| "problem-dismissed"
		| "compaction";
	/** The model-facing text ("" for plan blocks — UI-only). */
	content: string;
	display: boolean;
	/** The UI payload — per-customType, never model-visible. */
	details: unknown;
	timestamp: number;
}

/** A record message: a native pi message (or our marker) plus the record id. */
export type LhMessage = (UserMessage | AssistantMessage | ToolResultMessage | LhMarkerMessage) & { id: string };


// ─── id minting ──────────────────────────────────────────────────────────────

/** The app-wide message id shape (same as the UIMessage-era mint). */
export function newMessageId(): string {
	return mintId("msg");
}

/** The user-facing text blocks of a native message (string or text parts). */
export function textOf(content: unknown): string[] {
	if (typeof content === "string") return content.trim() ? [content] : [];
	if (!Array.isArray(content)) return [];
	return content
		.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
		.map((c) => c.text)
		.filter((t) => t.trim().length > 0);
}

// ─── constructors (the input-event → native append mapping lives in
//     core/input-events.ts; steers in core/contracts/jobs.ts) ─────────────────

/** A learner-authored user message (text input, verdict note). */
export function newUserMessage(text: string): LhMessage & UserMessage {
	return {
		id: newMessageId(),
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

/** A steered user message (mid-turn composer steering, owner 2026-10-03):
 *  a plain user message with the CLIENT-minted steer id — the same object
 *  rides agent.steer(), the live stream's message events, and the settled
 *  record, so the optimistic queued indicator and the transcript card
 *  upsert by one identity. */
export function newUserSteer(text: string, id: string): LhMessage & UserMessage {
	return { id, role: "user", content: text, timestamp: Date.now() };
}

/** The learner's answer — the question call's tool result (fork 1).
 *  TWO AUDIENCES (owner, tool-result diet 2026-10-02): the MODEL sees the
 *  compact learner-only record (compactAnswerForModel — the call's own
 *  arguments already carry the question/options/explanation/commitment;
 *  restating them doubled every answer's tokens), while `details` keeps
 *  the FULL graded QuestionAnswerData for the record and the UI. */
export function newAnswerResult(
	toolCallId: string,
	toolName: string,
	answer: unknown,
): LhMessage & ToolResultMessage {
	return {
		id: newMessageId(),
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: JSON.stringify(compactAnswerForModel(answer as QuestionAnswerData)) }],
		// 0.87.1 narrowed ToolResultMessage.details to JsonRepresentation —
		// our payloads are JSON-safe answer structures, so the cast is honest.
		details: answer as ToolResultMessage["details"],
		isError: false,
		timestamp: Date.now(),
	};
}

/** The probe→teach handoff wake: scaffolding, not speech — the model reads
 *  HANDOFF_TEXT, the UI renders the quiet system line. */
export function newHandoffMessage(chatId: string): LhMarkerMessage {
	return {
		id: `steer_probe_${chatId}`,
		role: "custom",
		customType: "probe-handoff",
		content: HANDOFF_TEXT,
		display: true,
		details: { chatId },
		timestamp: Date.now(),
	};
}

/** The plan presentation block: pure UI history (a frozen snapshot), no
 *  model face — wireOf drops it. `planCallId` keys idempotent
 *  emission (one block per successful plan_init call). */
export function newPlanBlockMessage(
	planCallId: string,
	block: unknown,
): LhMarkerMessage {
	return {
		id: mintId("pb"),
		role: "custom",
		customType: "plan-block",
		content: "",
		display: true,
		details: { planCallId, block },
		timestamp: Date.now(),
	};
}

// ─── practice sessions (owner, 2026-10-04) ───────────────────────────────────

/** The practice agent's two tools (the conclude-before-next-problem gate's
 *  vocabulary — the tool-execute layer owns the tools themselves). */
export const PRACTICE_PROBLEM_TOOL = "problem";
export const PRACTICE_CONCLUDE_TOOL = "conclude";

/** One picked proposition of the graph-context marker (the learner's map
 *  pick — name + statement as the learner SAW them at pick time). */
export interface GraphContextPick {
	id: string;
	name: string;
	statement: string;
}

/** The session's map context (owner, 2026-10-04): a SEPARATE custom
 *  message BEFORE the learner's first user message — the picked
 *  propositions plus the reasoning chains among them (pre-formatted
 *  lines, formatChainLine shape). The model reads `content` (flattened
 *  to a user message by wireOf like every marker); `details`
 *  feeds the transcript's collapsible GraphContextCard. No more seed
 *  text glued into the first prompt. */
export function newGraphContextMessage(picks: readonly GraphContextPick[], chains: readonly string[]): LhMarkerMessage {
	// IDS FIRST (owner round 9, 2026-10-05 — the mastery-trace contract):
	// each proposition is introduced ONCE with its id, name, and statement;
	// the problem tool's `target` field takes these ids (names normalize to
	// ids at the seam). Chains below stay NAMES — they are comprehension
	// context, not tags; names read, ids reference.
	const lines = [
		// PREAMBLE LAW (owner, 2026-10-10): custom markers flatten to
		// USER-role messages on the wire (wireOf) — this text arrives
		// in the learner's voice channel, so it must not read like a system
		// broadcast. The bracket convention (NEXT_PROBLEM_TEXT's kin) marks
		// it honestly as injected session context, not learner speech.
		"[Session context] — picked from the learner's knowledge map when starting this session:",
		"",
		"Propositions (id — name: statement; the problem tool's target field uses these ids):",
		...picks.map((p) => `- [${p.id}] ${p.name}: ${p.statement}`),
	];
	if (chains.length > 0) {
		lines.push("", "Reasoning chains among them (premises → conclusion):", ...chains.map((c) => `- ${c}`));
	}
	return {
		id: newMessageId(),
		role: "custom",
		customType: "graph-context",
		content: lines.join("\n"),
		display: true,
		details: { propositions: picks, chains },
		timestamp: Date.now(),
	};
}

/** The learner's thinking submission (ONE send lane, owner round
 *  2026-10-05): the register is no longer declared by a button — the
 *  model READS the text to tell working traces from claimed answers. The
 *  content label is the single "Your thinking"; `details` keeps the raw
 *  payload for the transcript card. One problem may carry many
 *  submissions. */
export function newThinkingMessage(problemCallId: string, text: string): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "practice-thinking",
		content: `${THINKING_LABEL}:\n${text}`,
		display: true,
		details: { problemCallId, text },
		timestamp: Date.now(),
	};
}

/** The learner's explicit move-on signal (owner round 16): appended by
 *  the next input (the composer band's chip, or Enter on an empty
 *  composer during the between-problems pause). The content is the
 *  single-sourced NEXT_PROBLEM_TEXT — the model's unambiguous go-ahead;
 *  the transcript renders its own compact line off the marker (never
 *  the content). */
export function newNextMessage(): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "practice-next",
		content: NEXT_PROBLEM_TEXT,
		display: true,
		details: {},
		timestamp: Date.now(),
	};
}

/** The problem-dismissal marker (ask-style discard, owner 2026-10-04):
 *  UI-ONLY — wireOf drops it. The model's face arrives later, at
 *  the user's next input, as the synthesized conclude pair
 *  (concludedByDismissalPair below) — the agent sees the dismissal as a
 *  conclude call it "made" with outcome "dismissed", so the slot-freed
 *  state and the dismissal read through the one vocabulary it owns. */
export function newProblemDismissedMarker(problemCallId: string): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "problem-dismissed",
		content: "",
		display: true,
		details: { problemCallId },
		timestamp: Date.now(),
	};
}

/** The dismissal's deferred conclude (owner ruling 2026-10-04): the pair
 *  prepended to the user's NEXT input — a synthetic assistant message
 *  carrying a conclude call (outcome "dismissed") plus its ack result, so
 *  both the record and the model context read the problem as concluded
 *  by dismissal, slot freed. Pure; ids are deterministic off the problem
 *  call id (idempotent shape — the pending-dismissal gate guarantees the
 *  pair appends at most once per marker). */
export function concludedByDismissalPair(
	problemCallId: string,
): [LhMessage & AssistantMessage, LhMessage & ToolResultMessage] {
	const callId = `call_conc_${problemCallId}`;
	const now = Date.now();
	// The stamps are placeholders by design: history serialization reads
	// ONLY the content blocks (verified in pi-ai's converters), and the
	// app's money channel is the parallel turns log, never message
	// objects — so "synthetic" never corrupts a wire view or a cost fold.
	const syntheticStamps = {
		api: "faux",
		provider: "synthetic",
		model: "synthetic-conclude",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
	} as const;
	return [
		{
			id: newMessageId(),
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: PRACTICE_CONCLUDE_TOOL, arguments: { outcome: "dismissed" } }],
			timestamp: now,
			...syntheticStamps,
		},
		{
			id: newMessageId(),
			role: "toolResult",
			toolCallId: callId,
			toolName: PRACTICE_CONCLUDE_TOOL,
			content: [{ type: "text", text: CONCLUDE_ACK_TEXT }],
			details: { outcome: "dismissed", problemCallId },
			isError: false,
			timestamp: now,
		},
	];
}

/** The active-problem fold (the conclude-before-next-problem gate): the
 *  NEWEST problem tool call with nothing concluding after it — either a
 *  conclude call or a dismissal marker deactivates. The ack result at pose
 *  time does NOT (the problem stays on screen through nudges; the dock's
 *  subject is the call, not a dangling result). */
/** The ids of tool calls whose results are CLEAN (not errored) — the only
 *  calls that ever happened, per the honest-activation ruling. */
function cleanToolCallIds(messages: readonly LhMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as ToolResultMessage;
		if (!result.isError) ids.add(result.toolCallId);
	}
	return ids;
}

/** The conclusion's reveal (owner round, 2026-10-05): the hero of a
 *  conclude card is the modelSolution committed at POSE time — the newest
 *  cleanly-posed problem BEFORE this conclude call. The reveal is never
 *  re-authored (the slim schema dropped solutionReveal); legacy conclude
 *  inputs that still carry their own solutionReveal fall back to it at the
 *  card. Undefined when the pose carries no string solution. */
export function modelSolutionForConclude(
	messages: readonly LhMessage[],
	concludeCallId: string,
): string | undefined {
	const input = problemInputForConclude(messages, concludeCallId);
	return typeof input?.modelSolution === "string" ? input.modelSolution : undefined;
}

/** The full pose-side fold (owner round 17, 2026-10-06 — observability):
 * EVERYTHING the agent filled into the problem call — mode, target ids,
 * statement, the committed solution — joined onto the conclude part so
 * the card's collapsible "agent's data" drawer renders pure. Same walk
 * and refusal law as the reveal: a pose the record never acked (a
 * refused call) folds nothing. */
export function problemInputForConclude(
	messages: readonly LhMessage[],
	concludeCallId: string,
): { statement?: unknown; mode?: unknown; target?: unknown; modelSolution?: unknown } | undefined {
	let mi = messages.findIndex(
		(m) =>
			(m as { role?: string }).role === "assistant" &&
			(m as AssistantMessage).content.some(
				(b) => b.type === "toolCall" && b.id === concludeCallId,
			),
	);
	if (mi < 0) return undefined;
	const clean = cleanToolCallIds(messages);
	for (; mi >= 0; mi--) {
		const m = messages[mi]!;
		if ((m as { role?: string }).role !== "assistant") continue;
		const assistant = m as AssistantMessage;
		for (let bi = assistant.content.length - 1; bi >= 0; bi--) {
			const block = assistant.content[bi]!;
			if (block.type !== "toolCall" || block.name !== PRACTICE_PROBLEM_TOOL) continue;
			if (!clean.has(block.id)) continue; // a refused pose revealed nothing
			return (block.arguments ?? undefined) as
				| { statement?: unknown; mode?: unknown; target?: unknown; modelSolution?: unknown }
				| undefined;
		}
	}
	return undefined;
}

export function activeProblemOf(
	messages: readonly LhMessage[],
): { toolCallId: string; input: unknown } | null {
	// HONEST ACTIVATION (owner ruling, 2026-10-05 — the BKT incident):
	// calls count only through their RESULTS — a problem activates on its
	// clean ack, a conclude frees on its clean ack; errored and dangling
	// calls are skipped ("either it goes through or it doesn't").
	const cleanCallIds = cleanToolCallIds(messages);
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const m = messages[mi]!;
		const role = (m as { role?: string }).role;
		if (role === "custom") {
			const marker = m as LhMarkerMessage;
			if (marker.customType === "problem-dismissed") return null;
			continue;
		}
		if (role === "assistant") {
			const assistant = m as AssistantMessage & { id: string };
			for (let bi = assistant.content.length - 1; bi >= 0; bi--) {
				const block = assistant.content[bi]!;
				if (block.type !== "toolCall") continue;
				if (block.name === PRACTICE_CONCLUDE_TOOL) {
					if (cleanCallIds.has(block.id)) return null; // a CLEAN conclude frees
					continue; // errored/dangling conclude: the free never happened
				}
				if (block.name !== PRACTICE_PROBLEM_TOOL) continue;
				if (cleanCallIds.has(block.id)) return { toolCallId: block.id, input: block.arguments };
				// errored/dangling pose — it did not go through; keep scanning
			}
			continue;
		}
	}
	return null;
}

/** Is a problem-dismissal marker waiting for its conclude synthesis? The
 *  text/continue appends read this: the pair rides the user's next input
 *  (input-events). Newest-marker-wins scan: the first dismissal marker or
 *  conclude call from the end decides. */
export function pendingProblemDismissalOf(messages: readonly LhMessage[]): string | null {
	const cleanCallIds = cleanToolCallIds(messages);
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const m = messages[mi]!;
		const role = (m as { role?: string }).role;
		if (role === "custom") {
			const marker = m as LhMarkerMessage;
			if (marker.customType === "problem-dismissed") {
				return (marker.details as { problemCallId?: unknown }).problemCallId as string;
			}
			continue;
		}
		if (role === "assistant") {
			const assistant = m as AssistantMessage;
			for (let bi = assistant.content.length - 1; bi >= 0; bi--) {
				const block = assistant.content[bi]!;
				if (block.type !== "toolCall" && block.type !== "text") continue;
				if (block.type === "toolCall" && block.name === PRACTICE_CONCLUDE_TOOL) {
					if (cleanCallIds.has(block.id)) return null; // a CLEAN conclude settles it
					continue; // errored/dangling: it never happened
				}
				if (block.type === "toolCall" && block.name === PRACTICE_PROBLEM_TOOL) {
					if (cleanCallIds.has(block.id)) return null; // a CLEAN pose supersedes it
					continue;
				}
			}
			continue;
		}
	}
	return null;
}

// ─── the one model-facing seam ───────────────────────────────────────────────

/** Markers with no model face: the plan block is UI history, and a problem
 *  dismissal reaches the model later as its synthesized conclude pair. */
const UI_ONLY_MARKERS: ReadonlySet<LhMarkerMessage["customType"]> = new Set(["plan-block", "problem-dismissed"]);

/** The model-facing text of a marker, or null for a UI-only marker or a
 *  native message. */
export function modelTextOf(message: LhMessage): string | null {
	if (message.role !== "custom") return null;
	if (UI_ONLY_MARKERS.has(message.customType)) return null;
	return message.content;
}

/** The provider message one record message contributes, or null when it
 *  contributes none: markers flatten to a user message carrying their
 *  text, native messages lose the record id. */
export function wireOf(message: LhMessage): Message | null {
	if (message.role === "custom") {
		const text = modelTextOf(message);
		return text === null || text === ""
			? null
			: { role: "user", content: [{ type: "text", text }], timestamp: message.timestamp };
	}
	const { id: _id, ...native } = message;
	return native as Message;
}

/** The active compaction cut: the provider sees `head` (the summary), then
 *  the record from `keptId` onward, never the marker itself. Null when no
 *  marker is active or its kept message no longer exists — the marker then
 *  reaches the model as plain text where it sits. */
export interface CompactionCut {
	keptId: string;
	markerId: string;
	head: Message;
}

export function compactionCutOf(messages: readonly LhMessage[]): CompactionCut | null {
	const active = activeCompactionOf(messages);
	if (!active || keptIndexFor(messages, active) < 0) return null;
	const head = wireOf(active);
	if (!head) return null;
	return { keptId: active.details.firstKeptMessageId, markerId: active.id, head };
}

/** The ids of every toolResult in the tail (for the dangling-call scan). */
function resultIdsFrom(messages: readonly LhMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) {
		if (m.role === "toolResult") ids.add(m.toolCallId);
	}
	return ids;
}

/**
 * The record → the provider messages a request would carry: the compaction
 * cut, each message's wire form, and the interrupted result for every
 * dangling tool call (the provider rejects an unanswered call).
 */
export function toLlmMessages(messages: readonly LhMessage[]): Message[] {
	const cut = compactionCutOf(messages);
	const start = cut ? messages.findIndex((m) => m.id === cut.keptId) : 0;
	const out: Message[] = cut ? [cut.head] : [];
	for (let i = start; i < messages.length; i++) {
		const m = messages[i]!;
		if (cut && m.id === cut.markerId) continue;
		const wire = wireOf(m);
		if (wire) out.push(wire);
		if (m.role !== "assistant") continue;
		const calls = m.content.filter((b) => b.type === "toolCall");
		if (calls.length === 0) continue;
		const answered = resultIdsFrom(messages.slice(i + 1));
		for (const call of calls) {
			if (answered.has(call.id)) continue;
			out.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: INTERRUPTED_TEXT }],
				isError: false,
				timestamp: m.timestamp,
			});
		}
	}
	return out;
}

// ─── native scans (the UIMessage-era pending/phase seams, natively) ──────────

/** The pending-question gate (findPendingToolCall's native twin): the
 *  NEWEST assistant message's FIRST question-tool call still awaiting the
 *  learner — one question at a time, the dock's subject. A call counts as
 *  answered only through its RESULT; the durable loop commits the pose as
 *  a placeholder result (the clean "question posed" ack, details: null),
 *  so an existing result is not an answer by itself. The legacy shape (no
 *  result at all — records imported mid-question) stays pending. */
export function danglingQuestionOf(
	messages: readonly LhMessage[],
): { toolCallId: string; tool: string; input: unknown } | null {
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const m = messages[mi]!;
		if ((m as { role?: string }).role !== "assistant") continue;
		const assistant = m as AssistantMessage & { id: string };
		const results = new Map<string, ToolResultMessage>();
		for (const tail of messages.slice(mi + 1)) {
			if ((tail as { role?: string }).role !== "toolResult") continue;
			const result = tail as ToolResultMessage;
			results.set(result.toolCallId, result);
		}
		for (const block of assistant.content) {
			if (block.type !== "toolCall") continue;
			if (!isQuestionTool(block.name)) continue;
			const result = results.get(block.id);
			if (result === undefined || (!result.isError && result.details == null)) {
				return { toolCallId: block.id, tool: block.name, input: block.arguments };
			}
		}
		return null; // the newest assistant message's questions are all answered
	}
	return null;
}

/** The probe→teach construction seam (chat-handler): a probe_done call in
 *  the transcript — any state — means the probe is concluded: teach. */
export function hasProbeDone(messages: readonly LhMessage[]): boolean {
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const assistant = m as AssistantMessage;
		if (assistant.content.some((b) => b.type === "toolCall" && b.name === "probe_done")) return true;
	}
	return false;
}

/** Every toolResult id in the record — answer-event validation (the call
 *  must be a DANGLING question call, not an already-answered one). */
export function answeredCallIds(messages: readonly LhMessage[]): Set<string> {
	return resultIdsFrom(messages);
}

// ─── the continuation fold (Wave D: the SDK's
//     lastAssistantMessageIsCompleteWithToolCalls, natively) ──────────────────

/**
 * Does the record END on un-consumed tool results — a turn that stopped
 * after its tools ran (a job dispatch's ack, an aborted answer turn),
 * leaving the agent owing a continuation? This is the mount/sync
 * continuation seam's gate (chat.tsx): when true and nothing runs, the
 * client sends {type:"continue"} and the teacher picks up from the record.
 *
 * The pre-Wave-D client asked the SDK's
 * lastAssistantMessageIsCompleteWithToolCalls (last view message is
 * assistant; its last step's tool calls all output-available or
 * output-error; at least one). The native fold over the record: the last
 * message is a toolResult, and the results' OWNING assistant message has
 * at least one call, ALL of them answered (a dangling question — the
 * dock's domain — fails the all-answered rule and never fires a turn,
 * exactly as the SDK's every(output-available) did).
 */
/** Is this record message a user-dismissed question result? The full
 *  answer rides the toolResult's `details` (newAnswerResult) — the
 *  dismissal pause and the continuation fold both read it. */
function isDismissedResult(m: LhMessage): boolean {
	if ((m as { role?: string }).role !== "toolResult") return false;
	const details = (m as { details?: unknown }).details as { dismissed?: unknown } | undefined;
	return details?.dismissed === true;
}

/** The dismissal pause (owner design 2026-10-03, "A2"): the record ends
 *  in user dismissal — the session waits for the USER. While paused,
 *  nothing auto-wakes: the continuation fold demands nothing (below) and
 *  the wake pipeline holds job deliveries in the steer queue until the
 *  next send. Derived from the tail — no latch to persist or clear; any
 *  user message flips it off by changing the record. */
export function endsInDismissal(messages: readonly LhMessage[]): boolean {
	const last = messages[messages.length - 1];
	return last !== undefined && isDismissedResult(last);
}

/** The auto-continuation's progress signature: the transcript length and its
 *  newest message id. A failed run that commits no assistant entry leaves
 *  both unchanged, so the client can tell "still owed" from "still owed and
 *  nothing happened" and stop re-sending forever. */
export function continuationSignature(messages: readonly LhMessage[]): string {
	const last = messages[messages.length - 1] as { id?: string } | undefined;
	return `${messages.length}:${last?.id ?? ""}`;
}

export function needsContinuation(messages: readonly LhMessage[]): boolean {
	const last = messages[messages.length - 1];
	if (!last || (last as { role?: string }).role !== "toolResult") return false;
	// A pending question OWNS the next move: its committed placeholder result
	// is not a consumed tool result, so a mount/reload must not fire the
	// continuation turn the learner never asked for.
	if (danglingQuestionOf(messages) !== null) return false;
	// The trailing results batch (contiguous by construction — the agent
	// appends its batch; the question gate keeps a quiz call and its
	// learner answer adjacent).
	let start = messages.length - 1;
	while (
		start > 0 &&
		(messages[start - 1] as { role?: string } | undefined)?.role === "toolResult"
	) {
		start--;
	}
	// The dismissal rule (A2 + owner ruling 2026-10-03, round-1 incident):
	// the batch's LAST resolution decides. Ending on a dismissal = the
	// user signaled STOP — no wake, no reaction owed now; the answers'
	// reactions ride the user's next plain message. Ending on a real
	// answer = the reaction is owed. One law with the pump's pause
	// (endsInDismissal reads the same last result), so continuation,
	// delivery-holding, and the pause can never disagree.
	if (isDismissedResult(messages[messages.length - 1]!)) {
		return false;
	}
	const owner = messages[start - 1];
	if (!owner || (owner as { role?: string }).role !== "assistant") return false;
	const content = (owner as { content?: unknown }).content;
	if (!Array.isArray(content)) return false;
	const results = messages.slice(start) as ToolResultMessage[];
	// PRACTICE (owner design, 2026-10-04): a batch acking a problem POSE
	// owes nothing — terminate:true ended that turn DELIBERATELY (the
	// learner's next thinking submission is the next turn), and unlike a
	// question's placeholder this ack PERSISTS (the model reads its own
	// "Problem posed" result later). Without this fold a reload after a
	// pose would wake a phantom continuation turn.
	const posedProblem = results.some(
		(m) => m.toolName === PRACTICE_PROBLEM_TOOL && !m.isError && m.details == null,
	);
	if (posedProblem) return false;
	const answered = new Set(results.map((m) => m.toolCallId));
	const calls = (content as Array<{ type?: string; id?: string }>).filter(
		(b) => b.type === "toolCall" && typeof b.id === "string",
	);
	return calls.length > 0 && calls.every((b) => answered.has(b.id!));
}
