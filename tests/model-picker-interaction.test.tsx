import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ModelControl } from "../components/model-picker.tsx";
import { kbdEventForAction } from "../src/core/keyboard.ts";
import type { ModelCatalogEntry } from "../src/core/contracts/models.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement;

afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = undefined;
	host?.remove();
	globalThis.fetch = originalFetch;
});

it("the recovery event refreshes the session picker and only an explicit selection writes session settings", async () => {
	const model: ModelCatalogEntry = {
		id: "replacement-fixture",
		name: "Replacement fixture",
		provider: "custom-endpoint",
		reasoning: false,
		input: ["text"],
		supportedLevels: ["off"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
	let catalogReads = 0;
	const writes: { path: string; method: string; body: unknown }[] = [];
	globalThis.fetch = async (input, init) => {
		const path = String(input);
		const method = init?.method ?? "GET";
		if (method !== "GET") {
			writes.push({ path, method, body: JSON.parse(String(init?.body)) });
			assert.equal(path, "/api/chats/fixture-chat/settings");
			assert.equal(method, "PUT");
			return Response.json({ settings: writes.at(-1)!.body });
		}
		if (path === "/api/models") {
			catalogReads++;
			return Response.json({ models: catalogReads === 1 ? [] : [model], providers: [], slots: { strong: null, cheap: null, vision: null } });
		}
		if (path === "/api/settings") return Response.json({ settings: null });
		assert.equal(path, "/api/chats/fixture-chat");
		return Response.json({ settings: { model: { provider: model.provider, id: "retired-fixture" }, thinkingLevel: "off" } });
	};
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => { root!.render(<ModelControl chatId="fixture-chat" />); });
	assert.equal(catalogReads, 1);
	assert.equal(document.querySelector('[data-testid="model-menu"]'), null);

	async function openPicker() {
		await act(async () => { window.dispatchEvent(new dom.window.Event(kbdEventForAction("open-model-picker"))); });
	}
	await openPicker();
	assert.equal(catalogReads, 2);
	assert.ok(document.querySelector('[data-testid="model-menu"]'));
	assert.ok(document.querySelector('[data-testid="model-option-replacement-fixture"]'));
	assert.deepEqual(writes, []);
	assert.equal(document.querySelector('[data-testid="setup-dialog"]'), null);

	await act(async () => {
		const event = new dom.window.Event("keydown", { bubbles: true });
		Object.assign(event, { key: "Escape" });
		document.dispatchEvent(event);
	});
	assert.equal(document.querySelector('[data-testid="model-menu"]'), null);
	assert.deepEqual(writes, []);

	await openPicker();
	assert.equal(catalogReads, 3);
	const option = document.querySelector<HTMLElement>('[data-testid="model-option-replacement-fixture"]');
	assert.ok(option);
	await act(async () => { option.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
	assert.deepEqual(writes, [{
		path: "/api/chats/fixture-chat/settings",
		method: "PUT",
		body: { model: { provider: "custom-endpoint", id: "replacement-fixture" }, thinkingLevel: "off" },
	}]);
	assert.equal(document.querySelector('[data-testid="model-menu"]'), null);
	assert.ok(document.querySelector('[data-testid="stats-model"]')?.textContent?.includes("replacement-fixture"));
});
