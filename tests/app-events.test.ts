import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const realWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window: unknown }).window = new EventTarget();
const { emitAppEvent, emitKeyAction, onAppEvent, onKeyAction } = await import("../src/lib/events.ts");

afterEach(() => {
	(globalThis as { window: unknown }).window = realWindow ?? new EventTarget();
});

describe("the page event bus", () => {
	it("delivers a typed detail and stops after unsubscribe", () => {
		const got: string[] = [];
		const off = onAppEvent("settings-saved", ({ section }) => got.push(section));
		emitAppEvent("settings-saved", { section: "models" });
		off();
		emitAppEvent("settings-saved", { section: "keys" });
		assert.deepEqual(got, ["models"]);
	});

	it("a key action reaches only its own listeners", () => {
		const got: string[] = [];
		const offs = [onKeyAction("toggle-sidebar", () => got.push("sidebar")), onKeyAction("find", () => got.push("find"))];
		emitKeyAction("toggle-sidebar");
		for (const off of offs) off();
		emitKeyAction("toggle-sidebar");
		assert.deepEqual(got, ["sidebar"]);
	});
});
