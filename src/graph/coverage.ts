/**
 * Extraction coverage. THE TEACHER'S PROSE IS THE UNIT (owner decision):
 * the extractor sees ONLY the teacher agent's
 * text blocks — no learner messages, no thinking, no tool calls or
 * results, no quiz blocks. Everything else is INVISIBLE to coverage: it
 * neither opens nor joins a run, so answering a quiz or editing a learner
 * message triggers nothing. "Covered" is by construction exactly "what
 * the extractor saw": the fingerprint (sha256 of a message's view lines)
 * and the extractor's prompt share ONE selection — the teacher prose.
 *
 * A per-chat append-only ledger records which messages have been
 * extracted by CONTENT FINGERPRINT; "uncovered" is DERIVED at read time
 * (fingerprint the current transcript, diff against the ledger) — never
 * dual-tracked. Runs are token-budgeted batches of the oldest uncovered
 * teacher-prose messages: greedy consecutive fill, a message is never
 * split, a single over-budget message rides alone.
 */

import { tokensForChars } from "../platform/model/index.ts";
import { createHash } from "node:crypto";

import type { CoverageEntry } from "./model/types.ts";
import { textOf, type LhMessage } from "../session/model/index.ts";


/**
 * The extraction-relevant lines of ONE native message — the shared seam
 * between the extractor's prompt and messageFingerprint (coverage).
 * TEACHER PROSE ONLY: an assistant message yields one
 * line per text block; everything else (user messages, tool results,
 * markers) yields NOTHING and is invisible to coverage. `mid` is the
 * message id — part of the hash input, so the same prose in two messages
 * is two slots (per-message coverage).
 */
export function messageViewLines(message: LhMessage, mid: string): string[] {
	const lines: string[] = [];
	if ((message as { role?: string }).role !== "assistant") return lines;
	for (const text of textOf((message as { content: unknown }).content)) {
		lines.push(`TEACHER [${mid}] ${text.trim()}`);
	}
	return lines;
}

function viewTokens(lines: string[]): number {
	return tokensForChars(lines.join("\n").length);
}

/**
 * A message's coverage fingerprint: sha256 of role + its view lines (the
 * teacher prose, with the message id as the tag). Changes exactly when
 * the teacher prose of the message changes — nothing else can re-open it.
 */
function messageFingerprint(message: LhMessage): string {
	const h = createHash("sha256");
	h.update(JSON.stringify([(message as { role?: string }).role, messageViewLines(message, message.id)]));
	return h.digest("hex");
}

interface CoverageSlot {
	message: LhMessage;
	fp: string;
	tokens: number;
}

/** Fingerprint a whole transcript, in order (used by the trigger, the run,
 *  and the coverage view — one derivation everywhere). */
function coverageSlots(messages: ReadonlyArray<LhMessage>): CoverageSlot[] {
	return messages.map((message) => ({ message, fp: messageFingerprint(message), tokens: viewTokens(messageViewLines(message, message.id)) }));
}

function coveredSet(entries: ReadonlyArray<CoverageEntry>, chatId: string): Set<string> {
	const out = new Set<string>();
	for (const e of entries) if (e.chatId === chatId) out.add(e.fp);
	return out;
}

/** The derived state: which slots are uncovered, plus the token totals.
 *  "Uncovered" needs no ledger of its own — this diff IS the coverage view.
 *  `uncovered` is INDEXES into `slots` (the batcher batches by position).
 *  Messages with NO view lines — every learner message, every tool result,
 *  markers, prose-less assistant turns — are invisible to coverage
 *  entirely: the extractor can never see them, so they are neither covered
 *  nor uncovered. */
export function coverageOf(
	messages: ReadonlyArray<LhMessage>,
	entries: ReadonlyArray<CoverageEntry>,
	chatId: string,
): {
	slots: CoverageSlot[];
	uncovered: number[];
	coveredTokens: number;
	uncoveredTokens: number;
	coveredCount: number;
	uncoveredCount: number;
} {
	const covered = coveredSet(entries, chatId);
	const slots = coverageSlots(messages);
	const uncovered: number[] = [];
	let coveredTokens = 0;
	let uncoveredTokens = 0;
	for (let i = 0; i < slots.length; i++) {
		const slot = slots[i]!;
		if (messageViewLines(slot.message, slot.message.id).length === 0) continue;
		if (covered.has(slot.fp)) coveredTokens += slot.tokens;
		else {
			uncovered.push(i);
			uncoveredTokens += slot.tokens;
		}
	}
	const visibleCount = slots.length - slots.filter(
		(s) => messageViewLines(s.message, s.message.id).length === 0,
	).length;
	return {
		slots,
		uncovered,
		coveredTokens,
		uncoveredTokens,
		coveredCount: visibleCount - uncovered.length,
		uncoveredCount: uncovered.length,
	};
}

/**
 * Batch the uncovered teacher-prose messages into token-budgeted RUNS:
 * consecutive slots, oldest first, greedy fill — a message is never split.
 * A single message larger than the budget becomes its own (over-budget)
 * run rather than being dropped. Runs are ephemeral — the durable record
 * is per-message coverage, checkpointed after each run merges.
 */
export function batchRuns(slots: ReadonlyArray<CoverageSlot>, uncovered: ReadonlyArray<number>, budget: number): CoverageSlot[][] {
	if (budget <= 0 || uncovered.length === 0) return [];
	const runs: CoverageSlot[][] = [];
	let current: CoverageSlot[] = [];
	let currentTokens = 0;
	const flush = () => {
		if (current.length > 0) runs.push(current);
		current = [];
		currentTokens = 0;
	};
	for (const i of uncovered) {
		const slot = slots[i]!;
		if (current.length > 0 && currentTokens + slot.tokens > budget) flush();
		current.push(slot);
		currentTokens += slot.tokens;
	}
	flush();
	return runs;
}

