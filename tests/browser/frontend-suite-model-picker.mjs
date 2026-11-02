/**
 * Model picker interaction (old tests/model-picker-interaction.test.tsx).
 *
 * The seeded chat points at a retired model; the catalog carries the
 * replacement. Opening the picker (keyboard action) refreshes the catalog;
 * Escape closes with no write; only an explicit option click writes the
 * whole per-chat settings object, and the stats chip follows it.
 */
import assert from "node:assert/strict";
import { browser, installApiProbe, apiCalls, sleep } from "./frontend-harness.mjs";

export const SEEDED_CHAT = "chat_mv27rrra_feff23b6";
export const RETIRED_MODEL = "retired-fixture";

export async function configureScriptedProvider(run, { models = ["mock-responses", "mock-responses-b"] } = {}) {
	const endpoint = await run.jsonApi("/api/custom-endpoint", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			displayName: "LOCAL SCRIPTED MOCK",
			baseUrl: `${run.mockBase}/v1`,
			models: models.map((id) => ({
				id,
				name: id,
				contextWindow: 100_000,
				maxTokens: 4_096,
				reasoning: false,
				imageInput: true,
			})),
			apiKey: "lh-gap-dummy-custom-key-000000000001",
		}),
	});
	assert.equal(endpoint.res.status, 200, `custom endpoint → ${endpoint.res.status} ${JSON.stringify(endpoint.body)}`);
	return endpoint.body;
}

export async function run(run, check) {
	const settings = await run.jsonApi(`/api/chats/${SEEDED_CHAT}`);
	assert.equal(settings.res.status, 200, `GET seeded chat → ${settings.res.status}`);
	assert.equal(settings.body.settings?.model?.id, RETIRED_MODEL, "the seeded chat does not point at the retired model");

	await check("model picker: open refreshes the catalog, Escape writes nothing, an explicit pick writes the session settings", async () => {
		const page = browser(run, "model-picker");
		try {
			await page.goto(`/chat/${SEEDED_CHAT}`, { ready: '[data-testid="model-control"]' });
			await page.waitForJs(`!!document.querySelector('[data-testid=stats-model]')`, 10_000, "stats model chip");
			installApiProbe(page);
			const before = page.js(`({
				chip: document.querySelector('[data-testid=stats-model]').innerText,
				expanded: document.querySelector('[data-testid=stats-model]').getAttribute('aria-expanded'),
				menu: !!document.querySelector('[data-testid=model-menu]'),
			})`);
			assert.ok(before.chip.includes(RETIRED_MODEL), `stats chip does not show the stored retired model: ${JSON.stringify(before.chip)}`);
			assert.equal(before.expanded, "false", "the picker started expanded");
			assert.equal(before.menu, false, "the model menu was mounted before opening");

			page.press("Control+k");
			await page.waitForJs(`!!document.querySelector('[data-testid=model-menu]')`, 8_000, "model menu after the keyboard action");
			const opened = page.js(`({
				options: [...document.querySelectorAll('[data-testid^=model-option-]')].map((node) => node.getAttribute('data-testid')),
				retiredOption: !!document.querySelector('[data-testid=model-option-${RETIRED_MODEL}]'),
				setup: !!document.querySelector('[data-testid=setup-dialog]'),
				expanded: document.querySelector('[data-testid=stats-model]').getAttribute('aria-expanded'),
			})`);
			assert.ok(opened.options.includes("model-option-mock-responses"), "the replacement model is missing from the menu");
			assert.ok(opened.options.includes("model-option-mock-responses-b"), "the second catalog model is missing");
			assert.equal(opened.retiredOption, false, "the retired model is still in the catalog");
			assert.equal(opened.setup, false, "opening the picker opened setup");
			assert.equal(opened.expanded, "true", "the chip did not report the open menu");
			const readsAfterOpen = apiCalls(page).filter((call) => call.method === "GET" && call.pathname === "/api/models").length;
			assert.ok(readsAfterOpen >= 1, "opening the picker did not refresh /api/models");

			page.press("Escape");
			await page.waitForJs(`!document.querySelector('[data-testid=model-menu]')`, 5_000, "Escape closes the model menu");
			await sleep(400);
			const writesAfterEscape = apiCalls(page).filter((call) => call.method !== "GET");
			assert.deepEqual(writesAfterEscape, [], "closing the picker wrote settings");

			page.press("Control+k");
			await page.waitForJs(`!!document.querySelector('[data-testid=model-menu]')`, 8_000, "model menu reopened");
			const readsAfterReopen = apiCalls(page).filter((call) => call.method === "GET" && call.pathname === "/api/models").length;
			assert.ok(readsAfterReopen > readsAfterOpen, "reopening the picker did not refresh the catalog");
			page.click('[data-testid="model-option-mock-responses-b"]');
			await page.waitForJs(`!document.querySelector('[data-testid=model-menu]')`, 6_000, "menu closed on pick");
			await page.waitForJs(`document.querySelector('[data-testid=stats-model]').innerText.includes('mock-responses-b')`, 6_000, "stats chip follows the pick");
			const writes = apiCalls(page).filter((call) => call.method !== "GET");
			assert.equal(writes.length, 1, `expected exactly one settings write, saw ${writes.length}`);
			assert.equal(writes[0].pathname, `/api/chats/${SEEDED_CHAT}/settings`, "the pick wrote a different route");
			assert.equal(writes[0].method, "PUT", "the pick used a non-PUT method");
			const expected = {
				model: { provider: "custom-endpoint", id: "mock-responses-b" },
				thinkingLevel: "off",
			};
			assert.deepEqual(JSON.parse(writes[0].body), expected, "the pick wrote a different settings body");
			const stored = await run.getChat(SEEDED_CHAT);
			assert.deepEqual(stored.settings, expected, "the per-chat settings were not persisted");
			assert.equal(page.exists('[data-testid="setup-dialog"]'), false, "the pick opened setup");
			const finalChip = await page.q('[data-testid="stats-model"]');
			assert.ok(finalChip.includes("mock-responses-b"), "the stats chip did not settle on the picked model");
			page.screenshot("model-picker-01-after-pick");
			return { before, opened, writes: writes.length, expected, probeReads: readsAfterReopen };
		} finally {
			page.close();
		}
	});
}
