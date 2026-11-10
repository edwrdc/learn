/**
 * The chat-turn services — one named, error-contained seam per turn
 * responsibility, extracted from the chat-handler so it composes instead of
 * implementing. Each takes its dependencies explicitly (storage ports)
 * — no module here imports an adapter.
 *
 *   answerWrite / applyAnswer — the learner's graded answer as the posed
 *                        question's EFFECTIVE result: a ContextEdit over the
 *                        committed pose placeholder.
 *   writeDismissal     — the dismissal path: the same write, no run.
 *   TurnDoc / readTurn / writeTurn / claimTurnSettle / markTurnSettled —
 *                        the durable turn admission + settle descriptor a
 *                        reopened process rebuilds the finish path from.
 *   appendPlanBlocks   — the plan presentation marker, idempotent per
 *                        plan_init call.
 *   appendRunUsage     — the money channel, from the run's assistant entries
 *                        (aborted attempts excluded).
 *   triggerExtraction  — the graph write channel: fires the extraction
 *                        pipeline (the sole graph writer) once a chat
 *                        crosses the token-budget batch threshold.
 *
 * Logs are the minimal-observability baseline: one line per failure, tagged
 * [chat <id>] — structured logging lands behind these seams later.
 */

import type { LhMessage } from "./model/transcript.ts";
import type { QuestionAnswerData } from "./model/questions.ts";
import {
	dismissAppends,
	inputAppends,
	type DismissInput,
} from "./model/input-events.ts";
import { planBlocksFor } from "./model/plan-blocks.ts";
import { coverageOf } from "../graph/index.ts";
import { emit } from "../platform/model/index.ts";
import type { ChatStore } from "./model/ports.ts";
import type { GraphStore } from "../graph/model/index.ts";
import type { ExtractionPipeline } from "../graph/index.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../settings/model/index.ts";
import { defineDoc, type EntryId, type JsonObject } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	appendEntries,
	appendMessages,
	editDraftFor,
	entryMessageId,
	findToolResultEntry,
	openChatRuntime,
	readChatMessages,
	readEntries,
	type ChatRuntime,
} from "./durable.ts";
import type { ChatPhase } from "./model/phases.ts";
import { usageFromPi, type CallUsage } from "./model/types.ts";
import type { Message } from "@earendil-works/pi-ai";
import type { ModelSnapshot } from "../platform/index.ts";

/** One foreground turn's durable admission + settle descriptor: everything a
 *  later process needs to rebuild the finish path, with no closure and no
 *  copy of the mutable record. `settle` is the durable finish mark — a
 *  process that dies after the run ends but before the services land leaves
 *  "running"/"settling", and the next open re-runs them (they are idempotent
 *  by turn/entry id). */
export interface ForegroundTurn {
	/** The TurnUsage id: money provenance and the settle identity. */
	turnId: string;
	/** The admission's stable request id (`turn:<turnId>`); its committed
	 *  submission record is the proof the run was admitted. */
	requestId: string;
	/** `<provider>:<model>` the run was admitted under (TurnUsage's model). */
	modelId: string;
	model: ModelSnapshot;
	/** The extension identity at admission — the phase must not flip when the
	 *  interrupted run already committed a probe_done. */
	phase: ChatPhase;
	/** Entries committed before the admitted input: the settle slice boundary. */
	baseEntryCount: number;
	settle: "running" | "settling" | "settled";
}

/** The root conversation's descriptor of its current foreground turn. */
const TurnDoc = defineDoc<JsonObject>({
	kind: "lh.turn",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({
		turnId: "",
		requestId: "",
		modelId: "",
		model: { provider: "", modelId: "" },
		phase: "probe",
		baseEntryCount: 0,
		settle: "settled",
	}),
	checkpointWhen: () => false,
});

/** The chat's admitted turn, or undefined when it never admitted one. */
export async function readTurn(runtime: ChatRuntime): Promise<ForegroundTurn | undefined> {
	const doc = (await runtime.harness.snapshot(TurnDoc, runtime.root.id, BACKGROUND_CONTEXT)) as
		| JsonObject
		| undefined;
	return typeof doc?.turnId === "string" && doc.turnId.length > 0
		? (doc as unknown as ForegroundTurn)
		: undefined;
}

/** Record (or replace) the chat's turn descriptor at admission. */
export async function writeTurn(runtime: ChatRuntime, turn: ForegroundTurn): Promise<void> {
	await runtime.root.commit(async (tx) => {
		Object.assign(await tx.doc(TurnDoc, runtime.root.id), turn);
	}, BACKGROUND_CONTEXT);
}

/** Claim the turn's app settle services. False means they already landed (or
 *  a newer turn owns the root). A finisher that died mid-settle leaves
 *  "settling", which the next open re-runs. */
export async function claimTurnSettle(runtime: ChatRuntime, turnId: string): Promise<boolean> {
	return runtime.root.commit(async (tx) => {
		const doc = await tx.doc(TurnDoc, runtime.root.id);
		if (doc.turnId !== turnId || doc.settle === "settled") return false;
		doc.settle = "settling";
		return true;
	}, BACKGROUND_CONTEXT);
}

/** Mark the turn's services durably applied. */
export async function markTurnSettled(runtime: ChatRuntime, turnId: string): Promise<void> {
	await runtime.root.commit(async (tx) => {
		const doc = await tx.doc(TurnDoc, runtime.root.id);
		if (doc.turnId === turnId) doc.settle = "settled";
	}, BACKGROUND_CONTEXT);
}

/** One answer ready to write: the record message, plus the pose entry it
 *  replaces when the record committed one (the durable shape). */
interface AnswerWrite {
	message: LhMessage;
	replace: EntryId;
}

/**
 * Validate an answer against the record (the orphan-400 discipline: the call
 * must be a pending question) and resolve how it lands. A durable record
 * committed the pose as the call's result — a placeholder (details: null) —
 * so the answer REPLACES that entry.
 */
export async function answerWrite(
	chatId: string,
	record: { messages: readonly LhMessage[] },
	toolCallId: string,
	answer: QuestionAnswerData,
): Promise<AnswerWrite> {
	const appended = inputAppends({ messages: [...record.messages] }, { type: "answer", toolCallId, answer });
	const message = appended[0]!;
	const runtime = await openChatRuntime(chatId);
	const placeholder = await findToolResultEntry(runtime, toolCallId);
	if (!placeholder) throw new Error(`[chat ${chatId}] question ${toolCallId} has no committed placeholder`);
	return { message, replace: placeholder.id };
}

/** Land an answer write (see answerWrite). */
export async function applyAnswer(chatId: string, write: AnswerWrite): Promise<void> {
	await appendEntries(chatId, [editDraftFor(write.replace, write.message)]);
}

/** Write a dismissal — the question's tool result, or the practice
 *  problem's UI-only discard marker. No run starts. Emits the record change
 *  so open views refetch (the caller owns the activity timestamp). */
export async function writeDismissal(chatId: string, input: DismissInput): Promise<void> {
	const messages = await readChatMessages(chatId);
	const record = { messages: [...messages] };
	if (input.type === "dismiss-problem") {
		await appendMessages(chatId, dismissAppends(record, input));
	} else {
		const write = await answerWrite(chatId, record, input.toolCallId, input.answer);
		await applyAnswer(chatId, write);
	}
	emit("record-changed", { chatId });
}

/** The plan presentation markers a finished run owes, idempotent per
 *  plan_init call (the run's entries are already committed). The emitted set
 *  reads the SETTLED
 *  projection: a settle replayed after a crash must not append a second
 *  block for the same call. */
export async function appendPlanBlocks(
	chatStore: ChatStore,
	chatId: string,
	before: readonly LhMessage[],
	after: readonly LhMessage[],
): Promise<void> {
	try {
		const record = await chatStore.getChat(chatId);
		if (!record) return;
		const blocks = planBlocksFor(after, after.slice(before.length), record.tree, after);
		if (blocks.length > 0) {
			await appendMessages(chatId, blocks);
			await chatStore.touchChat(chatId);
		}
	} catch (err) {
		console.error(`[chat ${chatId}] plan-block emission failed:`, err);
	}
}

/** The money channel for one run: one TurnUsage built from the assistant
 *  entries the run committed, keyed to the first one (provenance). A
 *  cancelled attempt is not a billed step — partial/estimated usage on an
 *  aborted message is not money spent, the app's long-standing rule. */
export async function appendRunUsage(
	chatStore: ChatStore,
	chatId: string,
	baseEntryCount: number,
	turnUsageId: string,
	model: string,
): Promise<void> {
	try {
		const runtime = await openChatRuntime(chatId);
		const entries = (await readEntries(runtime)).slice(baseEntryCount);
		const steps: CallUsage[] = [];
		let messageId: string | undefined;
		for (const entry of entries) {
			const message = entry.model?.[0] as Message | undefined;
			if (message?.role !== "assistant") continue;
			messageId ??= entryMessageId(entry);
			if (message.stopReason === "aborted") continue;
			steps.push(usageFromPi(message.usage));
		}
		if (!messageId || steps.length === 0) return;
		await chatStore.appendTurnUsage(chatId, {
			id: turnUsageId,
			messageId,
			at: new Date().toISOString(),
			model,
			steps,
		});
	} catch (err) {
		console.error(`[chat ${chatId}] turn usage append failed:`, err);
	}
}

/**
 * The graph write channel (vision §1 construction): the extraction pipeline
 * (extractor → auditor → merger — the sole graph writer) runs ASYNC once a
 * chat's UNCOVERED transcript tokens reach the chunk budget
 * (vision-extraction-coverage.md, 2026-09-15). Coverage reads through the
 * projection (the record is native history; the extraction view stays
 * client-shaped).
 *
 * Deliberately isolated in this one seam — the pipeline is
 * trigger-agnostic.
 */
export async function triggerExtraction(
	deps: { chatStore: ChatStore; graphStore: GraphStore },
	extraction: ExtractionPipeline,
	chatId: string,
	chunkTokens: number,
): Promise<void> {
	try {
		const record = await deps.chatStore.getChat(chatId);
		if (!record) return;
		const covered = coverageOf(record.messages, deps.graphStore.readCoverage(), chatId);
		if (covered.uncoveredTokens < chunkTokens) return;
		void extraction.runExtraction(chatId).catch((err) => {
			// BYOK (owner, 2026-09-22) + key presence (provider-key interlude,
			// 2026-09-25): an unconfigured OR keyless write channel SKIPS (the
			// coverage ledger keeps the messages uncovered — the next trigger
			// retries once slots/keys are set); only real failures log.
			if (err instanceof ModelsNotConfiguredError) {
				console.info(`[chat ${chatId}] extraction skipped — ${err.envelope.error} (missing: ${err.envelope.missing.join(", ")})`);
				return;
			}
			if (err instanceof ProviderKeyMissingError) {
				console.info(`[chat ${chatId}] extraction skipped — ${err.envelope.error} (provider: ${err.envelope.provider})`);
				return;
			}
			console.error(`[chat ${chatId}] extraction pipeline failed:`, err);
		});
	} catch (err) {
		console.error(`[chat ${chatId}] extraction trigger failed:`, err);
	}
}
