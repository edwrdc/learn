import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escAbortTarget } from "../src/lib/chat/chat-logic.ts";

/**
 * THE LAYERED ESC (owner report, 2026-10-04): Esc over an open overlay —
 * a mermaid focus, the plan popup, the setup dialog — must CLOSE THE
 * OVERLAY, never dismiss a pending question (or abort a turn) underneath.
 * The overlays register with dismissLayer, which claims the Escape before
 * the window-level abort-turn dispatch; what reaches escAbortTarget is an
 * unclaimed Escape. Priority = stacking order.
 */
describe("escAbortTarget (the layered-Esc ruling)", () => {
	const none = { abortAsk: false, pending: false, problem: false, busy: false };

	it("the 2026-10-02 chain stands (question before turn)", () => {
		assert.equal(escAbortTarget({ ...none, pending: true }), "question");
		assert.equal(escAbortTarget({ ...none, busy: true }), "turn");
		assert.equal(escAbortTarget(none), null);
		assert.equal(escAbortTarget({ ...none, pending: true, busy: true }), "question", "a pending question outranks the turn");
	});

	it("an active practice problem sits between question and turn (2026-10-04)", () => {
		assert.equal(escAbortTarget({ ...none, problem: true }), "problem");
		assert.equal(escAbortTarget({ ...none, problem: true, busy: true }), "problem", "the problem card outranks the turn abort");
	});

	it("the abort confirm is topmost — its own Esc is claimed by the dialog", () => {
		assert.equal(escAbortTarget({ ...none, abortAsk: true, pending: true }), null, "never chain: the dialog owns that Esc");
	});
});
