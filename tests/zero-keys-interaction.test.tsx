import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { useZeroKeys } from "../components/setup-cta.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement;
const emptyKeys = { keys: [], providers: [] };
const noCustomKey = { keyPresent: false };

function Probe() {
	return <output>{String(useZeroKeys())}</output>;
}

async function mount() {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => { root!.render(<Probe />); });
}

function verdict() {
	return host.textContent;
}

function successfulReads(keyPresent = false) {
	globalThis.fetch = async (input) => Response.json(
		String(input) === "/api/keys" ? emptyKeys : { keyPresent },
	);
}

afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = undefined;
	host?.remove();
	globalThis.fetch = originalFetch;
});

describe("useZeroKeys status reads", () => {
	it("a failed initial custom-endpoint read must not claim zero keys", async () => {
		globalThis.fetch = async (input) => {
			if (String(input) === "/api/keys") return Response.json(emptyKeys);
			throw new Error("fixture connection failure");
		};
		await mount();
		assert.equal(verdict(), "false");
	});

	for (const pendingPath of ["/api/keys", "/api/custom-endpoint"]) {
		it(`keeps the initial verdict until ${pendingPath} completes`, async () => {
			let resolve!: (value: Response) => void;
			const pending = new Promise<Response>((done) => { resolve = done; });
			globalThis.fetch = async (input) => String(input) === pendingPath
				? pending
				: Response.json(String(input) === "/api/keys" ? emptyKeys : noCustomKey);
			await mount();
			assert.equal(verdict(), "false");
			await act(async () => { resolve(Response.json(pendingPath === "/api/keys" ? emptyKeys : noCustomKey)); });
			assert.equal(verdict(), "true");
		});
	}

	it("a custom-only provider key suppresses zero keys", async () => {
		successfulReads(true);
		await mount();
		assert.equal(verdict(), "false");
	});

	it("a complete keyless pair reports genuine zero keys", async () => {
		successfulReads();
		await mount();
		assert.equal(verdict(), "true");
	});

	for (const [id, providers, expected] of [
		["PROVIDER_API_KEY", [{ id: "provider", envVar: "PROVIDER_API_KEY", label: "Provider" }], false],
		["PROVIDER_API_KEY", undefined, false],
		["DEEPGRAM_API_KEY", undefined, true],
	] as const) {
		it(`classifies ${id} with ${providers ? "the provider roster" : "the legacy body"}`, async () => {
			globalThis.fetch = async (input) => Response.json(String(input) === "/api/keys"
				? { keys: [{ id, present: true, info: null, masked: "masked", source: "file", shadowedByEnv: false }], providers }
				: noCustomKey);
			await mount();
			assert.equal(verdict(), String(expected));
		});
	}

	it("successful refreshes update both verdicts", async () => {
		successfulReads();
		await mount();
		assert.equal(verdict(), "true");
		successfulReads(true);
		await act(async () => { notifySettingsSaved("keys"); });
		assert.equal(verdict(), "false");
		successfulReads();
		await act(async () => { notifySettingsSaved("keys"); });
		assert.equal(verdict(), "true");
	});

	const failures = [
		{ name: "network failure", read: async () => { throw new Error("fixture offline"); } },
		{ name: "HTTP failure with parseable JSON", read: async (path: string) => Response.json(path === "/api/keys" ? emptyKeys : noCustomKey, { status: 500 }) },
		{ name: "invalid JSON", read: async () => new Response("not JSON") },
		...([null, {}, [], { keys: null }, { keys: [null] }, { keys: [{ id: "p", present: "false" }] },
			{ keys: [], providers: null }, { keys: [], providers: [{}] }, { keyPresent: "false" }] as unknown[])
			.map((body) => ({ name: `invalid body ${JSON.stringify(body)}`, read: async () => Response.json(body) })),
	];

	for (const path of ["/api/keys", "/api/custom-endpoint"]) {
		for (const failure of failures) {
			it(`preserves initial false on ${path} ${failure.name}`, async () => {
				globalThis.fetch = async (input) => String(input) === path
					? failure.read(path)
					: Response.json(String(input) === "/api/keys" ? emptyKeys : noCustomKey);
				await mount();
				assert.equal(verdict(), "false");
			});
			for (const previous of [false, true]) {
				it(`preserves ${previous} on refresh with ${path} ${failure.name}`, async () => {
					successfulReads(!previous);
					await mount();
					assert.equal(verdict(), String(previous));
					globalThis.fetch = async (input) => String(input) === path
						? failure.read(path)
						: Response.json(String(input) === "/api/keys" ? emptyKeys : { keyPresent: previous });
					await act(async () => { notifySettingsSaved("keys"); });
					assert.equal(verdict(), String(previous));
				});
			}
		}
	}
});
