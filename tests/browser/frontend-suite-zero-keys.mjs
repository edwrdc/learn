/**
 * Zero-keys status transitions (old tests/zero-keys-interaction.test.tsx).
 *
 * Old contract, preserved here on real DOM + the app's own key routes:
 *  - the pill starts at "not zero" and only claims zero after BOTH
 *    /api/keys and /api/custom-endpoint resolve;
 *  - a failed read (network, HTTP error, invalid JSON, invalid body) never
 *    claims zero keys, and a failed refresh keeps the previous verdict;
 *  - a transcription-only (DEEPGRAM) key is not a provider key;
 *  - a custom-endpoint key suppresses zero keys;
 *  - a successful refresh (save then delete through the UI) moves the
 *    verdict both ways.
 */
import assert from "node:assert/strict";
import { browser, initScript, sleep } from "./frontend-harness.mjs";

const DUMMY_DEEPGRAM = "lh-gap-dummy-deepgram-key-0000000001";
const DUMMY_OPENROUTER = "lh-gap-dummy-openrouter-key-0000000001";
const DUMMY_CUSTOM = "lh-gap-dummy-custom-key-000000000001";
const CTA = '[data-testid="setup-cta-keys"]';

const delayScript = (endpoint, key) => `(() => {
	window.__probe = { keysRequestedAt: null, keysResolvedAt: null, customRequestedAt: null, customResolvedAt: null };
	const original = window.fetch;
	window.fetch = function (input, init) {
		const raw = typeof input === "string" ? input : (input && input.url) || "";
		let pathname = raw;
		try { pathname = new URL(raw, location.href).pathname; } catch {}
		if (pathname === ${JSON.stringify(endpoint)}) {
			window.__probe.${key}RequestedAt = performance.now();
			return new Promise((resolve, reject) => {
				setTimeout(() => {
					Promise.resolve(original.call(this, input, init)).then((response) => {
						window.__probe.${key}ResolvedAt = performance.now();
						resolve(response);
					}, (error) => {
						window.__probe.${key}ResolvedAt = performance.now();
						reject(error);
					});
				}, 2000);
			});
		}
		return original.apply(this, arguments);
	};
	return true;
})();`;

const FAILURES = {
	network: { body: 'Promise.reject(new TypeError("frontend-harness synthetic read failure"))' },
	http500: { body: `Promise.resolve(new Response(JSON.stringify({ error: "frontend-harness synthetic 500" }), { status: 500, headers: { "content-type": "application/json" } }))` },
	invalidJson: { body: `Promise.resolve(new Response("not JSON", { status: 200 }))` },
	invalidKeysBody: { body: `Promise.resolve(Response.json({ keys: null }))` },
	invalidCustomBody: { body: `Promise.resolve(Response.json({ keyPresent: "false" }))` },
};

/**
 * Bridge that fails one endpoint either on every call ("always") or from the
 * second call on ("refresh"), leaving every other request untouched.
 */
const failureScript = (endpoint, variant, when) => `(() => {
	window.__probe = { calls: 0, delivered: 0 };
	const original = window.fetch;
	window.fetch = function (input, init) {
		const raw = typeof input === "string" ? input : (input && input.url) || "";
		let pathname = raw;
		try { pathname = new URL(raw, location.href).pathname; } catch {}
		if (pathname === ${JSON.stringify(endpoint)}) {
			window.__probe.calls += 1;
			const fail = ${when === "always" ? "true" : when === "third" ? "window.__probe.calls >= 3" : "window.__probe.calls >= 2"};
			if (fail) return ${FAILURES[variant].body};
			return Promise.resolve(original.call(this, input, init)).then((response) => {
				window.__probe.delivered += 1;
				return response;
			});
		}
		return original.apply(this, arguments);
	};
	return true;
})();`;

export async function run(run, check) {
	const saveKey = (id, value) => run.jsonApi(`/api/keys/${id}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value }),
	});
	const deleteKey = (id) => run.jsonApi(`/api/keys/${id}`, { method: "DELETE" });
	const keysBody = async () => (await run.jsonApi("/api/keys")).body;
	const present = (body, id) => (body.keys ?? []).some((row) => row.id === id && row.present === true);
	const customKey = (apiKey) => run.jsonApi("/api/custom-endpoint", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			displayName: "LOCAL SCRIPTED MOCK",
			baseUrl: `${run.mockBase}/v1`,
			models: [{ id: "mock-responses", name: "mock-responses", contextWindow: 100_000, maxTokens: 4_096, reasoning: false, imageInput: true }],
			apiKey,
		}),
	});

	await check("zero keys: CTA appears only after the delayed /api/keys read resolves", async () => {
		const page = browser(run, "zero-pending-keys", {
			initScript: initScript(run, "delay-keys", delayScript("/api/keys", "keys")),
		});
		try {
			await page.goto("/", { ready: "textarea" });
			const early = page.js(`({ cta: !!document.querySelector(${JSON.stringify(CTA)}), probe: window.__probe })`);
			assert.equal(early.cta, false, "claimed zero keys before /api/keys resolved");
			assert.equal(early.probe.keysRequestedAt !== null, true, "the app never requested /api/keys");
			assert.equal(early.probe.keysResolvedAt, null, "the delayed read resolved before the observation window");
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(CTA)})`, 8_000, "zero-keys CTA after the delayed read");
			const probe = page.js("window.__probe");
			assert.ok(probe.keysResolvedAt - probe.keysRequestedAt >= 1_900, `delay was not applied: ${probe.keysResolvedAt - probe.keysRequestedAt} ms`);
			page.screenshot("zero-01-pending-keys-resolved");
			return { early, probe };
		} finally {
			page.close();
		}
	});

	await check("zero keys: CTA appears only after the delayed /api/custom-endpoint read resolves", async () => {
		const page = browser(run, "zero-pending-custom", {
			initScript: initScript(run, "delay-custom", delayScript("/api/custom-endpoint", "custom")),
		});
		try {
			await page.goto("/", { ready: "textarea" });
			const early = page.js(`({ cta: !!document.querySelector(${JSON.stringify(CTA)}), probe: window.__probe })`);
			assert.equal(early.cta, false, "claimed zero keys before /api/custom-endpoint resolved");
			assert.equal(early.probe.customRequestedAt !== null, true, "the app never requested /api/custom-endpoint");
			assert.equal(early.probe.customResolvedAt, null, "the delayed read resolved before the observation window");
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(CTA)})`, 8_000, "zero-keys CTA after the delayed custom-endpoint read");
			const probe = page.js("window.__probe");
			assert.ok(probe.customResolvedAt - probe.customRequestedAt >= 1_900, `delay was not applied: ${probe.customResolvedAt - probe.customRequestedAt} ms`);
			return { early, probe };
		} finally {
			page.close();
		}
	});

	const matrix = [
		["/api/keys", "network"],
		["/api/keys", "http500"],
		["/api/keys", "invalidJson"],
		["/api/keys", "invalidKeysBody"],
		["/api/custom-endpoint", "network"],
		["/api/custom-endpoint", "http500"],
		["/api/custom-endpoint", "invalidJson"],
		["/api/custom-endpoint", "invalidCustomBody"],
	];
	await check("zero keys: failed initial reads never claim zero keys", async () => {
		const observed = [];
		for (const [endpoint, variant] of matrix) {
			const page = browser(run, `zero-fail-${variant}-${endpoint.endsWith("keys") ? "keys" : "custom"}`, {
				initScript: initScript(run, `fail-${variant}-${endpoint.endsWith("keys") ? "keys" : "custom"}`, failureScript(endpoint, variant, "always")),
			});
			try {
				await page.goto("/", { ready: "textarea" });
				await sleep(1_500);
				const state = page.js(`({ cta: !!document.querySelector(${JSON.stringify(CTA)}), probe: window.__probe })`);
				assert.ok(state.probe.calls >= 1, `${endpoint} ${variant}: the synthetic failure was never triggered`);
				assert.equal(state.cta, false, `${endpoint} ${variant}: a failed read claimed zero keys`);
				observed.push({ endpoint, variant, calls: state.probe.calls });
			} finally {
				page.close();
			}
		}
		return { variants: observed.length };
	});

	await check("zero keys: a failed refresh keeps the previous zero verdict", async () => {
		const page = browser(run, "zero-refresh-preserve-true", {
			initScript: initScript(run, "refresh-fail-keys", failureScript("/api/keys", "network", "third")),
		});
		try {
			await page.goto("/", { ready: "textarea" });
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(CTA)})`, 6_000, "zero-keys CTA before the refresh");
			page.click(CTA);
			await page.waitForJs(`!!document.querySelector('[data-testid=setup-dialog]')`, 5_000, "setup dialog");
			page.click('[data-testid="setup-key-provider"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=provider-option-openrouter]')`, 5_000, "provider option");
			page.click('[data-testid="provider-option-openrouter"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=setup-key-input]')`, 5_000, "key input");
			page.fill('[data-testid="setup-key-input"]', DUMMY_OPENROUTER);
			page.click('[data-testid="setup-key-save"]');
			await page.waitForJs("window.__probe.calls >= 3", 8_000, "the failing refresh read");
			await sleep(1_000);
			const state = page.js(`({ cta: !!document.querySelector(${JSON.stringify(CTA)}), probe: window.__probe })`);
			assert.ok(state.probe.delivered >= 1, "no keys read succeeded before the injected failure");
			assert.equal(state.cta, true, "a failed refresh dropped the previous zero verdict");
			const stored = await keysBody();
			assert.equal(present(stored, "OPENROUTER_API_KEY"), true, "the key save did not land, so the refresh failure is not the cause");
			page.screenshot("zero-02-refresh-preserved-true");
			return state;
		} finally {
			page.close();
			await deleteKey("OPENROUTER_API_KEY");
		}
	});

	await check("zero keys: a failed refresh keeps the previous non-zero verdict", async () => {
		const saved = await saveKey("OPENROUTER_API_KEY", DUMMY_OPENROUTER);
		assert.equal(saved.res.status, 200, `seed provider key → ${saved.res.status}`);
		const page = browser(run, "zero-refresh-preserve-false", {
			initScript: initScript(run, "refresh-fail-keys-delete", failureScript("/api/keys", "http500", "third")),
		});
		try {
			await page.goto("/", { ready: "textarea" });
			await sleep(1_200);
			assert.equal(page.exists(CTA), false, "the seeded provider key did not start a non-zero verdict");
			page.press("Control+,");
			await page.waitForJs(`!!document.querySelector('[data-testid=settings-dialog]')`, 8_000, "settings dialog");
			page.click('[data-testid="settings-nav-keys"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=key-openrouter_api_key-row]')`, 8_000, "stored key row");
			page.click('[data-testid="key-openrouter_api_key-row"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=key-openrouter_api_key-delete]')`, 8_000, "delete control");
			page.click('[data-testid="key-openrouter_api_key-delete"]');
			await page.waitForJs("window.__probe.calls >= 3", 8_000, "the failing refresh read");
			await sleep(1_000);
			const state = page.js(`({ cta: !!document.querySelector(${JSON.stringify(CTA)}), probe: window.__probe })`);
			assert.ok(state.probe.delivered >= 1, "no keys read succeeded before the injected failure");
			assert.equal(state.cta, false, "a failed refresh introduced a zero-keys claim");
			const stored = await keysBody();
			assert.equal(present(stored, "OPENROUTER_API_KEY"), false, "the key delete did not land, so the refresh failure is not the cause");
			page.screenshot("zero-03-refresh-preserved-false");
			return state;
		} finally {
			page.close();
		}
	});

	await check("zero keys: a DEEPGRAM-only key is not a provider key", async () => {
		const saved = await saveKey("DEEPGRAM_API_KEY", DUMMY_DEEPGRAM);
		assert.equal(saved.res.status, 200, `save DEEPGRAM → ${saved.res.status}`);
		const body = await keysBody();
		assert.equal(present(body, "DEEPGRAM_API_KEY"), true, "DEEPGRAM key was not stored");
		assert.equal(body.keys.some((row) => row.id !== "DEEPGRAM_API_KEY" && row.present), false, "another key was present");
		const page = browser(run, "zero-deepgram");
		try {
			await page.goto("/", { ready: "textarea" });
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(CTA)})`, 6_000, "zero-keys CTA with only a DEEPGRAM key");
			return { deepgramPresent: true };
		} finally {
			page.close();
			const removed = await deleteKey("DEEPGRAM_API_KEY");
			assert.equal(removed.res.status, 200, `delete DEEPGRAM → ${removed.res.status}`);
		}
	});

	await check("zero keys: a custom-endpoint key suppresses zero keys", async () => {
		const endpoint = await customKey(DUMMY_CUSTOM);
		assert.equal(endpoint.res.status, 200, `custom endpoint → ${endpoint.res.status} ${JSON.stringify(endpoint.body)}`);
		const custom = (await run.jsonApi("/api/custom-endpoint")).body;
		assert.equal(custom.keyPresent, true, "custom endpoint key was not stored");
		const body = await keysBody();
		assert.equal(body.keys.some((row) => row.present), false, "a provider key was present, so the suppression is not attributable");
		const page = browser(run, "zero-custom");
		try {
			await page.goto("/", { ready: "textarea" });
			await sleep(1_500);
			const state = page.js(`({ cta: !!document.querySelector(${JSON.stringify(CTA)}), setup: !!document.querySelector('[data-testid=setup-cta]') })`);
			assert.equal(state.cta, false, "a custom-only key still claimed zero keys");
			await page.reload({ ready: "textarea" });
			await sleep(1_500);
			assert.equal(page.exists(CTA), false, "a custom-only key still claimed zero keys after reload");
			return { customKeyPresent: custom.keyPresent, ...state };
		} finally {
			page.close();
		}
	});

	await check("zero keys: removing the custom key restores the zero verdict", async () => {
		const removed = await run.jsonApi("/api/custom-endpoint", { method: "DELETE" });
		assert.equal(removed.res.status, 200, `delete custom endpoint → ${removed.res.status}`);
		const page = browser(run, "zero-custom-gone");
		try {
			await page.goto("/", { ready: "textarea" });
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(CTA)})`, 6_000, "zero-keys CTA after removing the custom key");
			return { cta: true };
		} finally {
			page.close();
		}
	});

	await check("zero keys: saving a provider key in setup and deleting it in Keys refreshes the verdict both ways", async () => {
		const page = browser(run, "zero-refresh-ui");
		try {
			await page.goto("/", { ready: "textarea" });
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(CTA)})`, 6_000, "zero-keys CTA before the UI save");
			page.click(CTA);
			await page.waitForJs(`!!document.querySelector('[data-testid=setup-dialog]')`, 5_000, "setup dialog");
			page.click('[data-testid="setup-key-provider"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=provider-option-openrouter]')`, 5_000, "provider option");
			page.click('[data-testid="provider-option-openrouter"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=setup-key-input]')`, 5_000, "key input");
			page.fill('[data-testid="setup-key-input"]', DUMMY_OPENROUTER);
			page.click('[data-testid="setup-key-save"]');
			await page.waitForJs(`!document.querySelector(${JSON.stringify(CTA)})`, 8_000, "zero-keys CTA removal after the key save");
			const afterSave = await keysBody();
			assert.equal(present(afterSave, "OPENROUTER_API_KEY"), true, "the UI save did not store the provider key");
			page.press("Escape");
			await page.waitForJs(`!document.querySelector('[data-testid=setup-dialog]')`, 5_000, "setup dialog closed");
			page.screenshot("zero-04-provider-key-saved");
			page.press("Control+,");
			await page.waitForJs(`!!document.querySelector('[data-testid=settings-dialog]')`, 8_000, "settings dialog");
			page.click('[data-testid="settings-nav-keys"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=key-openrouter_api_key-row]')`, 8_000, "stored key row");
			page.click('[data-testid="key-openrouter_api_key-row"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=key-openrouter_api_key-delete]')`, 8_000, "stored key delete control");
			page.click('[data-testid="key-openrouter_api_key-delete"]');
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(CTA)})`, 8_000, "zero-keys CTA restored after deleting the key");
			const afterDelete = await keysBody();
			assert.equal(present(afterDelete, "OPENROUTER_API_KEY"), false, "the UI delete did not remove the provider key");
			page.screenshot("zero-05-provider-key-deleted");
			return { saved: true, deleted: true };
		} finally {
			page.close();
		}
	});
}
