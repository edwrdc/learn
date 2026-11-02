/** The backdrop rule on the Svelte attachment: a whole primary gesture
 *  that starts AND ends on the scrim closes; drags beginning inside never
 *  do. Driven through linkedom events, no React. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { backdropDismiss } from "../src/lib/backdrop.ts";

const { document } = parseHTML("<html><body></body></html>");
function el(tag = "div") {
	return document.createElement(tag) as HTMLElement;
}
function pointer(target: EventTarget, type: string, over: Record<string, unknown> = {}) {
	const event = new (document.defaultView as unknown as { Event: typeof Event }).Event(type, { bubbles: true, cancelable: true });
	Object.assign(event, { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, detail: 1, ...over });
	target.dispatchEvent(event);
}
function click(target: EventTarget, over: Record<string, unknown> = {}) {
	pointer(target, "click", over);
}

describe("backdrop dismissal", () => {
	it("a whole primary gesture on the scrim closes exactly once", () => {
		const backdrop = el();
		let dismissals = 0;
		const off = backdropDismiss(() => dismissals++)(backdrop);
		pointer(backdrop, "pointerdown");
		pointer(backdrop, "pointerup");
		click(backdrop);
		assert.equal(dismissals, 1);
		click(backdrop);
		assert.equal(dismissals, 1, "a bare click after the gesture does nothing");
		off();
	});

	it("a press inside the dialog never dismisses, whichever endpoint releases", () => {
		for (const [downOn, upOn] of [["inside", "backdrop"], ["backdrop", "inside"]] as const) {
			const backdrop = el();
			const inside = el();
			backdrop.appendChild(inside);
			let dismissals = 0;
			backdropDismiss(() => dismissals++)(backdrop);
			pointer(downOn === "inside" ? inside : backdrop, "pointerdown");
			pointer(upOn === "inside" ? inside : backdrop, "pointerup");
			click(backdrop);
			assert.equal(dismissals, 0, `${downOn}→${upOn}`);
		}
	});

	it("a mismatched pointer, right/middle button or non-primary pointer never starts", () => {
		// The release must be the same pointer that pressed.
		const backdrop = el();
		let dismissals = 0;
		backdropDismiss(() => dismissals++)(backdrop);
		pointer(backdrop, "pointerdown", { pointerId: 1 });
		pointer(backdrop, "pointerup", { pointerId: 2 });
		click(backdrop);
		assert.equal(dismissals, 0, "mismatched pointerId");

		for (const over of [{ isPrimary: false }, { button: 2 }, { button: 1 }]) {
			const node = el();
			let fired = 0;
			backdropDismiss(() => fired++)(node);
			pointer(node, "pointerdown", over);
			pointer(node, "pointerup", over);
			click(node, over);
			assert.equal(fired, 0, JSON.stringify(over));
		}
	});

	it("pointer cancellation invalidates the press, before or after release", () => {
		const backdrop = el();
		let dismissals = 0;
		backdropDismiss(() => dismissals++)(backdrop);
		pointer(backdrop, "pointerdown");
		pointer(backdrop, "pointercancel");
		pointer(backdrop, "pointerup");
		click(backdrop);
		assert.equal(dismissals, 0);
		pointer(backdrop, "pointerdown");
		pointer(backdrop, "pointerup");
		pointer(backdrop, "pointercancel");
		click(backdrop);
		assert.equal(dismissals, 0);
	});

	it("inside buttons keep their own action without closing", () => {
		const backdrop = el();
		const inside = el("button");
		backdrop.appendChild(inside);
		let dismissals = 0;
		let clicks = 0;
		inside.addEventListener("click", () => clicks++);
		backdropDismiss(() => dismissals++)(backdrop);
		pointer(inside, "pointerdown");
		pointer(inside, "pointerup");
		click(inside);
		assert.equal(clicks, 1);
		assert.equal(dismissals, 0);
	});

	it("a reattached callback governs the next gesture (the busy guard seam)", () => {
		const backdrop = el();
		let dismissals = 0;
		let busy = true;
		const attach = () => backdropDismiss(() => { if (!busy) dismissals++; });
		let off = attach()(backdrop);
		pointer(backdrop, "pointerdown");
		pointer(backdrop, "pointerup");
		click(backdrop);
		assert.equal(dismissals, 0, "busy guard holds");
		off();
		busy = false;
		off = attach()(backdrop);
		pointer(backdrop, "pointerdown");
		pointer(backdrop, "pointerup");
		click(backdrop);
		assert.equal(dismissals, 1);
		off();
	});
});
