import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	actionForBinding,
	bindingForAction,
	formatBinding,
	IS_MAC,
	KEYBOARD_ACTIONS,
} from "../src/settings/model/keyboard.ts";

/**
 * The ⌘B sidebar bug interlude (owner, 2026-09-25): ⌘B did nothing because
 * the sidebar listened on the pre-convention "lh:toggle-sidebar" while the
 * dispatcher sent "lh:kbd-toggle-sidebar". The fix is structural — both
 * sides compose the event name through the ONE helper. These pins hold
 * the registry half (keypress → action); the dispatch → listener round
 * trip is pinned in app-events.test.ts.
 */

describe("the ⌘B chain — keypress → binding → action", () => {
	it("mod+t is the toggle-user-thinking action (owner round, 2026-10-07)", () => {
		assert.equal(actionForBinding("mod+t"), "toggle-user-thinking");
		assert.equal(bindingForAction("toggle-user-thinking"), "mod+t");
	});

	it("mod+b is the toggle-sidebar action", () => {
		assert.equal(actionForBinding("mod+b"), "toggle-sidebar");
		assert.equal(bindingForAction("toggle-sidebar"), "mod+b");
		assert.equal(formatBinding("mod+b"), IS_MAC ? "⌘B" : "Ctrl+B");
	});
});

describe("the thinking pill suffix — ⇧⇥ via the registry", () => {
	it("shift+tab uses the platform's modifier label and maps to cycle-thinking", () => {
		assert.equal(actionForBinding("shift+tab"), "cycle-thinking");
		assert.equal(formatBinding("shift+tab"), IS_MAC ? "⇧⇥" : "Shift+⇥");
	});
});

describe("the Alt session cycle is RETIRED (owner, 2026-10-10)", () => {
	// Barely used, felt laggy — session navigation lives IN the search
	// now (↑/↓ walk the filtered list, Enter opens; sidebar.tsx).
	it("⌥↑ / ⌥↓ / ⌥↵ bind to NOTHING — no stray action fires", () => {
		assert.equal(actionForBinding("alt+arrowup") ?? null, null);
		assert.equal(actionForBinding("alt+arrowdown") ?? null, null);
		assert.equal(actionForBinding("alt+enter") ?? null, null);
	});

	it("the actions are gone from the table (cheat sheet + settings render the registry)", () => {
		const ids = KEYBOARD_ACTIONS.map((a) => a.id as string);
		assert.ok(!ids.includes("cycle-session-prev"));
		assert.ok(!ids.includes("cycle-session-next"));
		assert.ok(!ids.includes("open-session"));
	});
});