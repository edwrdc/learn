/**
 * The dock shell's variant key — the WAAPI height-morph trigger. Pinned
 * after the practice-fold fix (owner, 2026-10-06): the expanded term
 * belongs to every docked variant, so a practice dock's fold/unfold
 * morphs exactly like a teaching question's. Before the fix the key
 * read `pending ? expanded : "-"` — pending is null in practice, the
 * key never changed on the fold, and the practice dock's height jumped
 * instantly between form and bar while teaching morphed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dockStateKey } from "../src/lib/chat/dock-state-key.ts";

describe("dockStateKey (the height-morph trigger)", () => {
	it("a docked variant's fold changes the key — practice and question alike", () => {
		for (const mode of ["practice:call_p1", "question:call_q1"]) {
			assert.notEqual(dockStateKey(mode, true, true), dockStateKey(mode, true, false), mode);
		}
	});

	it("switching variants changes the key", () => {
		assert.notEqual(dockStateKey("practice:call_p1", true, true), dockStateKey("question:call_q1", true, true));
		assert.notEqual(dockStateKey("chat", false, true), dockStateKey("practice:call_p1", true, true));
	});

	it("an undocked band (the composer) ignores the fold", () => {
		assert.equal(dockStateKey("chat", false, true), dockStateKey("chat", false, false));
	});
});
