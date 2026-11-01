/**
 * The chat-turn services — one named, error-contained seam per turn
 * responsibility, extracted from the chat-handler so it composes instead of
 * implementing. Each takes its dependencies explicitly (storage ports)
 * — no module here imports an adapter.
 *
 *   answerWrite / applyAnswer — the learner's graded answer as the posed
 *                        question's EFFECTIVE result: a ContextEdit over the
 *                        committed pose placeholder (or a plain append for a
 *                        legacy record that never committed one).
 *   writeDismissal     — the dismissal path: the same write, no run.
 *   appendPlanBlocks   — the plan presentation marker, idempotent per
 *                        plan_init call (the old persistTurn slice).
 *   appendRunUsage     — the money channel, from the run's assistant entries
 *                        (aborted attempts excluded).
 *   triggerExtraction  — the graph write channel: fires the extraction
 *                        pipeline (the sole graph writer) once a chat
 *                        crosses the token-budget batch threshold.
 *
 * Logs are the minimal-observability baseline: one line per failure, tagged
 * [chat <id>] — structured logging lands behind these seams later.
 */

import type { LhMessage } from "../core/native-messages.ts";
import type { QuestionAnswerData } from "../core/question-core.ts";
import {
	ChatInputError,
	dismissAppends,
	inputAppends,
	type DismissInput,
} from "../core/input-events.ts";
import { planBlocksFor } from "../core/plan-blocks.ts";
import { coverageOf } from "../core/coverage.ts";
import { emit } from "../core/events.ts";
import type { ChatStore, GraphStore } from "../core/ports.ts";
import type { ExtractionPipeline } from "../agent/subagents/extraction.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import type { EntryId } from "@earendil-works/pi-durable";
import {
	appendEntries,
	appendMessages,
	editDraftFor,
	findToolResultEntry,
	openChatRuntime,
	readChatMessages,
	readEntries,
} from "../store/durable.ts";
import type { CallUsage } from "../core/contracts.ts";

/** One answer ready to write: the record message, plus the pose entry it
 *  replaces when the record committed one (the durable shape). */
export interface AnswerWrite {
	message: LhMessage;
	replace?: EntryId;
}

/**
 * Validate an answer against the record (the orphan-400 discipline: the call
 * must be a pending question) and resolve how it lands. A durable record
 * committed the pose as the call's result — a placeholder (details: null) —
 * so the answer REPLACES that entry; a legacy record without one appends the
 * result, which is what the old loop did.
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
	return placeholder ? { message, replace: placeholder.id } : { message };
}

/** Land an answer write (see answerWrite). */
export async function applyAnswer(chatId: string, write: AnswerWrite): Promise<void> {
	if (write.replace !== undefined) {
		await appendEntries(chatId, [editDraftFor(write.replace, write.message)]);
		return;
	}
	await appendMessages(chatId, [write.message]);
}

/** Write a dismissal — the question's tool result, or the practice
 *  problem's UI-only discard marker. No run starts. Emits the record change
 *  so open views refetch. */
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
 *  plan_init call (the old persistTurn emission, now an append: the run's
 *  entries are already committed). */
export async function appendPlanBlocks(
	chatStore: ChatStore,
	chatId: string,
	before: readonly LhMessage[],
	after: readonly LhMessage[],
): Promise<void> {
	try {
		const record = await chatStore.getChat(chatId);
		if (!record) return;
		const blocks = planBlocksFor(before, after.slice(before.length), record.tree, after);
		if (blocks.length > 0) await appendMessages(chatId, blocks);
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
			const message = entry.model?.[0] as
				| { role?: string; stopReason?: string; usage?: Record<string, number | undefined> }
				| undefined;
			if (message?.role !== "assistant") continue;
			messageId ??= (entry.data as { id?: string } | undefined)?.id ?? `e${entry.id}`;
			if (message.stopReason === "aborted" || !message.usage) continue;
			steps.push({
				inputTokens: message.usage.input ?? 0,
				outputTokens: message.usage.output ?? 0,
				cacheReadTokens: message.usage.cacheRead ?? 0,
				cacheWriteTokens: message.usage.cacheWrite ?? 0,
				reasoningTokens: message.usage.reasoning ?? 0,
			});
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
 * trigger-agnostic. Skipped under tests: scripted chats are fixtures, not
 * knowledge (the pipeline itself is tested directly with mock models).
 */
export async function triggerExtraction(
	deps: { chatStore: ChatStore; graphStore: GraphStore },
	extraction: ExtractionPipeline,
	chatId: string,
	chunkTokens: number,
): Promise<void> {
	if (process.env.NODE_ENV === "test") return;
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
