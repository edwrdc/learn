import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LhMessage } from "../src/session/model/transcript.ts";
import { newAnswerResult, newPlanBlockMessage, newUserMessage } from "../src/session/model/transcript.ts";

import {
	batchRuns,
	coverageOf,
	messageViewLines,
} from "../src/graph/coverage.ts";
import type { CoverageEntry } from "../src/graph/model/types.ts";

/**
 * Extraction coverage — the pure core under the TEACHER-PROSE ruling
 * (owner, 2026-09-28): the extractor sees only the teacher's text
 * blocks; fingerprints, slots, tokens, and batching all derive from that
 * one selection. Everything else is invisible — it neither opens nor
 * joins a run.
 */

function user(id: string, text: string): LhMessage {
	return { ...newUserMessage(text), id };
}

function teacher(id: string, text: string): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "text", text }],
	} as unknown as LhMessage;
}

/** An assistant message calling `calls` (each {id,name}) — the bond anchor. */
function assistantWithCalls(
	id: string,
	calls: Array<{ id: string; name: string; args?: unknown }>,
): LhMessage {
	return {
		id,
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args ?? {} })),
	} as unknown as LhMessage;
}

function result(id: string, callId: string, name: string, details: unknown): LhMessage {
	return { ...newAnswerResult(callId, name, details), id } as LhMessage;
}

function slot(messages: ReadonlyArray<LhMessage>, id: string) {
	const found = coverageOf(messages, [], "c1").slots.find((s) => s.message.id === id);
	assert.ok(found, `slot ${id}`);
	return found;
}

function foldAll(messages: ReadonlyArray<LhMessage>): CoverageEntry[] {
	return coverageOf(messages, [], "c1").slots.map((s) => ({
		chatId: "c1",
		fp: s.fp,
		tokens: s.tokens,
		foldedAt: "2026-09-15T00:00:00.000Z",
	}));
}

describe("coverage fingerprint — what re-opens a folded message, what never does", () => {
	it("a text edit re-opens a folded teacher message; the same text stays covered", () => {
		const folded = foldAll([teacher("m1", "hello world")]);
		assert.equal(coverageOf([teacher("m1", "hello worlds")], folded, "c1").uncoveredCount, 1);
		assert.equal(coverageOf([teacher("m1", "hello world")], folded, "c1").uncoveredCount, 0);
	});

	it("the message id is the provenance tag — the same prose under another id is not covered", () => {
		const folded = foldAll([teacher("m1", "same")]);
		assert.equal(coverageOf([teacher("m2", "same")], folded, "c1").uncoveredCount, 1);
	});

	it("marker messages are invisible — a plan-block attach never re-opens anything", () => {
		const marker = newPlanBlockMessage("call_p1", {
			kind: "full",
			at: "2026-09-26T00:00:00.000Z",
			current: null,
			nodes: [],
			edges: [],
		}) as LhMessage;
		assert.deepEqual(messageViewLines(marker, marker.id), []);
		const folded = foldAll([teacher("t1", "the chain rule")]);
		const cov = coverageOf([teacher("t1", "the chain rule"), marker], folded, "c1");
		assert.equal(cov.uncoveredCount, 0, "the attach re-opens neither the neighbour nor itself");
	});

	it("quiz Q&A is INVISIBLE under the teacher-prose ruling (owner, 2026-09-28)", () => {
		// Neither the asking message nor the graded answer produces view
		// lines — a quiz exchange can never open or join an extraction run.
		const asking = assistantWithCalls("a1", [{ id: "q1", name: "quiz", args: { question: "Q?" } }]);
		const answer = result("r1", "q1", "quiz", { questionText: "Q?", correct: true });
		assert.deepEqual(messageViewLines(asking, "a1"), []);
		assert.deepEqual(messageViewLines(answer, "r1"), []);
		assert.equal(slot([asking, answer], "a1").tokens, 0);
		assert.equal(slot([asking, answer], "r1").tokens, 0);
	});

	it("learner messages and ALL tool results are invisible — clean or failed", () => {
		assert.deepEqual(messageViewLines(user("u1", "teach me"), "u1"), []);
		const demo = result("r1", "j1", "demo", { title: "T" });
		assert.deepEqual(messageViewLines(demo, "r1"), []);
		const failed = {
			...newAnswerResult("j2", "visual", { oops: true }),
			isError: true,
		} as LhMessage;
		assert.deepEqual(messageViewLines(failed, "r9"), []);
	});

});

describe("coverageOf — uncovered is DERIVED, never dual-tracked", () => {
	it("diffs fingerprints: covered stays, uncovered counts, tokens split", () => {
		const messages = [teacher("m1", "aaaa"), teacher("m2", "bbbb"), teacher("m3", "cccc")];
		const fp1 = slot(messages, "m1").fp;
		const fp2 = slot(messages, "m2").fp;
		const entries: CoverageEntry[] = [
			{ chatId: "c1", fp: fp1, tokens: 1, foldedAt: "2026-09-15T00:00:00.000Z" },
			{ chatId: "c1", fp: fp2, tokens: 1, foldedAt: "2026-09-15T00:00:00.000Z" },
			// Another chat's entries are irrelevant to c1's coverage.
			{ chatId: "c2", fp: slot(messages, "m3").fp, tokens: 1, foldedAt: "2026-09-15T00:00:00.000Z" },
		];
		const cov = coverageOf(messages, entries, "c1");
		// `uncovered` is INDEXES (the batcher needs positions for bonding):
		assert.deepEqual(cov.uncovered, [2]);
		assert.deepEqual(cov.slots[cov.uncovered[0]!]!.message.id, "m3");
		assert.equal(cov.coveredCount, 2);
		assert.equal(cov.uncoveredCount, 1);
		assert.equal(cov.uncoveredTokens, slot(messages, "m3").tokens);
		assert.equal(cov.coveredTokens, slot(messages, "m1").tokens + slot(messages, "m2").tokens);
	});

	it("a mutated covered message re-opens itself, and only itself", () => {
		const messages = [teacher("m1", "aaaa"), teacher("m2", "bbbb")];
		const entries = foldAll(messages);
		assert.equal(coverageOf(messages, entries, "c1").uncoveredCount, 0);
		const mutated = [teacher("m1", "aaaa!"), messages[1]!];
		const cov = coverageOf(mutated, entries, "c1");
		assert.deepEqual(cov.uncovered, [0]);
		assert.equal(cov.slots[0]!.message.id, "m1");
	});
});

describe("batchRuns — token-budgeted, consecutive, never splits a message", () => {
	it("greedy oldest-first fill; the overflowing message starts the next run", () => {
		// Each message's view line is ~14 tok (chars/4) → budget 45 fits
		// three, the fourth overflows: [m1,m2,m3] + [m4].
		const { slots } = coverageOf([
			teacher("m1", "a".repeat(40)),
			teacher("m2", "b".repeat(40)),
			teacher("m3", "c".repeat(40)),
			teacher("m4", "d".repeat(40)),
		], [], "c1");
		const runs = batchRuns(slots, [0, 1, 2, 3], 45);
		assert.deepEqual(
			runs.map((r) => r.map((s) => s.message.id)),
			[["m1", "m2", "m3"], ["m4"]],
		);
	});

	it("a single message larger than the budget becomes its own over-budget run", () => {
		const { slots } = coverageOf([teacher("m1", "x".repeat(400)), teacher("m2", "y".repeat(20))], [], "c1");
		assert.deepEqual(
			batchRuns(slots, [0, 1], 10).map((r) => r.map((s) => s.message.id)),
			[["m1"], ["m2"]],
		);
	});

	it("an empty or non-positive budget never drops messages into a void", () => {
		assert.deepEqual(batchRuns(coverageOf([teacher("m1", "hi")], [], "c1").slots, [0], 0), []);
		assert.deepEqual(batchRuns([], [], 4096), []);
	});

	it("learner messages and tool results never join a batch — teacher prose only (owner, 2026-09-28)", () => {
		// The inseparability bond died with the ruling: tool results are
		// invisible, so nothing needs keeping together. Batches are pure
		// greedy runs over the TEACHER slots alone.
		const messages = [
			user("u1", "learner asks"),
			teacher("t1", "x".repeat(40)),
			result("r1", "q1", "quiz", { questionText: "Q?", correct: true }),
			teacher("t2", "y".repeat(40)),
		];
		const cov = coverageOf(messages, [], "c1");
		assert.deepEqual(cov.uncovered, [1, 3], "only the teacher-prose slots are uncovered");
		const runs = batchRuns(cov.slots, cov.uncovered, 15);
		assert.deepEqual(
			runs.map((r) => r.map((sl) => sl.message.id)),
			[["t1"], ["t2"]],
			"each run is teacher prose alone — the learner message and the quiz result ride nowhere",
		);
	});
});
