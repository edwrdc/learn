/**
 * Setup-dialog dropdown layering and copy (old tests/setup-dialog-interaction.tsx).
 *
 * Old contracts preserved on real pointer/keyboard gestures:
 *  - provider dropdown closes on a click elsewhere inside the dialog while
 *    setup stays open; the trigger toggles; picking an option reveals the key
 *    field;
 *  - Escape closes the dropdown first, then setup;
 *  - a genuine backdrop gesture closes setup and its dropdown;
 *  - a press that starts inside the dialog and releases on the backdrop never
 *    dismisses setup;
 *  - saving a key advances the dialog to the tier pickers;
 *  - the tier guidance copy, model/thinking outside-click dismissal, the
 *    empty vision list copy and the catalog-failure copy are exact;
 *  - opening or dismissing setup never writes model settings.
 */
import assert from "node:assert/strict";
import { browser, initScript, installApiProbe, apiCalls, sleep } from "./frontend-harness.mjs";

const DUMMY_OPENROUTER = "lh-gap-dummy-openrouter-key-0000000001";
const GUIDANCE = "Pick the model for each tier. All three are required before chats can start.";
const VISION_EMPTY = "No image-capable models. Add a provider key with access to a vision model.";
const CATALOG_FAILURE = "Model catalog could not be loaded. Check the connection and retry.";
const CTA_KEYS = '[data-testid="setup-cta-keys"]';
const CTA_MODELS = '[data-testid="setup-cta"]';
const DIALOG = '[data-testid="setup-dialog"]';
const PROVIDER_MENU = '[data-testid="setup-key-provider-menu"]';

const catalog = {
	models: [
		{
			id: "fixture-text",
			name: "Fixture text",
			provider: "openrouter",
			reasoning: false,
			input: ["text"],
			supportedLevels: ["off"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		},
		{
			id: "fixture-cheap",
			name: "Fixture cheap",
			provider: "openrouter",
			reasoning: false,
			input: ["text"],
			supportedLevels: ["off"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 512,
		},
	],
	providers: [{ id: "openrouter", keyPresent: true }],
	slots: { strong: null, cheap: null, vision: null },
};

const modelsBridge = (body) => `(() => {
	const original = window.fetch;
	window.fetch = function (input, init) {
		const raw = typeof input === "string" ? input : (input && input.url) || "";
		let pathname = raw;
		try { pathname = new URL(raw, location.href).pathname; } catch {}
		if (pathname === "/api/models") {
			return Promise.resolve(new Response(${JSON.stringify(JSON.stringify(body))}, { headers: { "content-type": "application/json" } }));
		}
		return original.apply(this, arguments);
	};
	return true;
})();`;

const modelsFailure = `(() => {
	const original = window.fetch;
	window.fetch = function (input, init) {
		const raw = typeof input === "string" ? input : (input && input.url) || "";
		let pathname = raw;
		try { pathname = new URL(raw, location.href).pathname; } catch {}
		if (pathname === "/api/models") return Promise.reject(new TypeError("frontend-harness synthetic catalog failure"));
		return original.apply(this, arguments);
	};
	return true;
})();`;

const noModelWrites = (calls) => calls.filter((call) => call.method !== "GET" && call.pathname === "/api/settings/models");

export async function run(run, check) {
	await check("setup: provider dropdown layering, Escape, backdrop and drag-out guard (stage keys)", async () => {
		const page = browser(run, "setup-stage-keys");
		try {
			await page.goto("/", { ready: 'textarea' });
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(CTA_KEYS)})`, 6_000, "zero-keys CTA");
			page.click(CTA_KEYS);
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(DIALOG)})`, 5_000, "setup dialog");
			installApiProbe(page);

			page.click('[data-testid="setup-key-provider"]');
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(PROVIDER_MENU)})`, 5_000, "provider menu");
			page.click(`${DIALOG} h2`);
			await page.waitForJs(`!document.querySelector(${JSON.stringify(PROVIDER_MENU)})`, 5_000, "provider menu closed by inside click");
			assert.equal(page.exists(DIALOG), true, "an inside click closed setup");

			page.click('[data-testid="setup-key-provider"]');
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(PROVIDER_MENU)})`, 5_000, "provider menu reopened");
			page.click('[data-testid="setup-key-provider"]');
			await page.waitForJs(`!document.querySelector(${JSON.stringify(PROVIDER_MENU)})`, 5_000, "provider trigger toggle close");
			page.click('[data-testid="setup-key-provider"]');
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(PROVIDER_MENU)})`, 5_000, "provider menu third open");
			page.click('[data-testid="provider-option-openrouter"]');
			await page.waitForJs(`!document.querySelector(${JSON.stringify(PROVIDER_MENU)})`, 5_000, "provider menu closed by pick");
			await page.waitForJs(`!!document.querySelector('[data-testid=setup-key-input]')`, 5_000, "key field after pick");
			assert.equal(page.exists(DIALOG), true, "picking a provider closed setup");

			page.click('[data-testid="setup-key-provider"]');
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(PROVIDER_MENU)})`, 5_000, "provider menu for Escape");
			page.press("Escape");
			await page.waitForJs(`!document.querySelector(${JSON.stringify(PROVIDER_MENU)})`, 5_000, "first Escape closes the dropdown");
			assert.equal(page.exists(DIALOG), true, "first Escape closed setup too");
			page.press("Escape");
			await page.waitForJs(`!document.querySelector(${JSON.stringify(DIALOG)})`, 5_000, "second Escape closes setup");
			assert.equal(page.exists(`[data-testid="setup-backdrop"]`), false, "backdrop stayed after the dialog closed");

			await page.waitForJs(`!!document.querySelector(${JSON.stringify(CTA_KEYS)})`, 5_000, "zero-keys CTA after Escape");
			page.click(CTA_KEYS);
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(DIALOG)})`, 5_000, "setup reopened for backdrop");
			page.click('[data-testid="setup-key-provider"]');
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(PROVIDER_MENU)})`, 5_000, "provider menu for backdrop");
			page.move(12, 12);
			page.down();
			page.up();
			await page.waitForJs(`!document.querySelector(${JSON.stringify(DIALOG)})`, 5_000, "genuine backdrop click closes setup");
			assert.equal(page.exists(PROVIDER_MENU), false, "the dropdown survived the dialog close");

			await page.waitForJs(`!!document.querySelector(${JSON.stringify(CTA_KEYS)})`, 5_000, "zero-keys CTA after backdrop");
			page.click(CTA_KEYS);
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(DIALOG)})`, 5_000, "setup reopened for drag-out");
			const title = page.box(`${DIALOG} h2`);
			assert.ok(title, "setup title box missing");
			page.move(Math.round(title.x + title.width / 2), Math.round(title.y + title.height / 2));
			page.down();
			page.move(12, 12);
			page.up();
			await sleep(600);
			assert.equal(page.exists(DIALOG), true, "an inside press released on the backdrop dismissed setup");
			const writesBeforeSave = noModelWrites(apiCalls(page));
			assert.deepEqual(writesBeforeSave, [], "dismissal gestures wrote model settings");
			page.screenshot("setup-01-drag-guard");

			page.click('[data-testid="setup-key-provider"]');
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(PROVIDER_MENU)})`, 5_000, "provider menu before the key save");
			page.click('[data-testid="provider-option-openrouter"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=setup-key-input]')`, 5_000, "key field before the key save");
			page.fill('[data-testid="setup-key-input"]', DUMMY_OPENROUTER);
			page.click('[data-testid="setup-key-save"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=setup-stage-pickers]')`, 10_000, "stage advanced to the tier pickers");
			assert.ok((await page.q('[data-testid="setup-stage-pickers"]')).includes(GUIDANCE), "tier guidance copy missing after the stage advance");
			await page.waitForJs(`!document.querySelector(${JSON.stringify(CTA_KEYS)})`, 6_000, "zero-keys CTA cleared by the key save");
			assert.deepEqual(noModelWrites(apiCalls(page)), [], "the key save wrote model settings");
			page.screenshot("setup-02-stage-pickers");
			page.press("Escape");
			await page.waitForJs(`!document.querySelector(${JSON.stringify(DIALOG)})`, 5_000, "setup closed after the stage checks");
			return { stageAdvanced: true, guidance: GUIDANCE };
		} finally {
			page.close();
		}
	});

	const cleared = await run.jsonApi("/api/settings/models", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	assert.equal(cleared.res.status, 200, `clear model slots → ${cleared.res.status} ${JSON.stringify(cleared.body)}`);

	await check("setup: tier pickers, exact guidance/vision copy, outside-click dismissal, no write (stage pickers)", async () => {
		const page = browser(run, "setup-stage-pickers", {
			initScript: initScript(run, "setup-catalog", modelsBridge(catalog)),
		});
		try {
			await page.goto("/", { ready: 'textarea' });
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(CTA_MODELS)})`, 6_000, "unconfigured-models CTA");
			page.click(CTA_MODELS);
			await page.waitForJs(`!!document.querySelector('[data-testid=setup-stage-pickers]')`, 6_000, "tier pickers stage");
			installApiProbe(page);
			const guidance = await page.q('[data-testid="setup-stage-pickers"] > p');
			assert.equal(guidance, GUIDANCE, "tier guidance copy drifted");

			page.click('[data-testid="setup-trigger-strong"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=setup-menu-strong]')`, 5_000, "strong model menu");
			assert.equal(page.exists('[data-testid="model-option-fixture-text"]'), true, "catalog option missing");
			page.click(`${DIALOG} h2`);
			await page.waitForJs(`!document.querySelector('[data-testid=setup-menu-strong]')`, 5_000, "strong menu closed by inside click");
			assert.equal(page.exists(DIALOG), true, "outside-click on the title closed setup");

			page.click('[data-testid="setup-trigger-strong"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=setup-menu-strong]')`, 5_000, "strong menu reopened");
			page.click('[data-testid="model-option-fixture-text"]');
			await page.waitForJs(`!document.querySelector('[data-testid=setup-menu-strong]')`, 5_000, "strong menu closed by pick");
			const thinkingEnabled = page.js(`!document.querySelector('[data-testid=setup-thinking-strong]').disabled`);
			assert.equal(thinkingEnabled, true, "thinking trigger disabled after picking a model");
			page.click('[data-testid="setup-thinking-strong"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=setup-thinking-menu-strong]')`, 5_000, "strong thinking menu");
			page.click(`${DIALOG} h2`);
			await page.waitForJs(`!document.querySelector('[data-testid=setup-thinking-menu-strong]')`, 5_000, "thinking menu closed by inside click");
			assert.equal(page.exists(DIALOG), true, "outside-click on the title closed setup with a thinking menu open");

			page.click('[data-testid="setup-trigger-vision"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=setup-menu-vision]')`, 5_000, "vision model menu");
			const vision = await page.q('[data-testid="setup-menu-vision"]');
			assert.ok(vision.includes(VISION_EMPTY), `vision empty copy drifted: ${JSON.stringify(vision)}`);
			page.click(`${DIALOG} h2`);
			await page.waitForJs(`!document.querySelector('[data-testid=setup-menu-vision]')`, 5_000, "vision menu closed");

			const saveDisabled = page.js(`document.querySelector('[data-testid=setup-save]').disabled`);
			assert.equal(saveDisabled, true, "save enabled with only one tier picked");
			assert.deepEqual(noModelWrites(apiCalls(page)), [], "interacting with the pickers wrote model settings");
			page.screenshot("setup-03-tier-pickers");
			return { guidance, vision: VISION_EMPTY, saveDisabled };
		} finally {
			page.close();
		}
	});

	await check("setup: catalog failure shows the approved two-sentence copy", async () => {
		const page = browser(run, "setup-catalog-failure", {
			initScript: initScript(run, "setup-catalog-failure", modelsFailure),
		});
		try {
			await page.goto("/", { ready: 'textarea' });
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(CTA_MODELS)})`, 6_000, "unconfigured-models CTA");
			page.click(CTA_MODELS);
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(DIALOG)})`, 6_000, "setup dialog");
			const text = await page.q(DIALOG);
			assert.ok(text.includes(CATALOG_FAILURE), `catalog failure copy drifted: ${JSON.stringify(text)}`);
			assert.equal(page.exists('[data-testid="setup-stage-keys"]'), false, "failure still rendered the key stage");
			installApiProbe(page);
			page.press("Escape");
			await page.waitForJs(`!document.querySelector(${JSON.stringify(DIALOG)})`, 5_000, "setup closed after failure");
			assert.deepEqual(noModelWrites(apiCalls(page)), [], "the failure path wrote model settings");
			page.screenshot("setup-04-catalog-failure");
			return { copy: CATALOG_FAILURE };
		} finally {
			page.close();
		}
	});
}
