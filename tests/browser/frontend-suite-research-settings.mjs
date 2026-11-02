/**
 * Agent settings: keyless Research toggle vs key-gated search engine
 * (old tests/research-settings.test.tsx).
 *
 *  - with no Tavily/Brave key the Research row stays interactive and
 *    unchecked-dim; its hint never borrows the search-engine reason;
 *  - the toggle writes the same stored boolean (tools.research=false) and
 *    keeps the rest of the agent section intact;
 *  - the search-engine preference keeps its own key gate: no menu, the row
 *    shows the reason, and nothing is written.
 */
import assert from "node:assert/strict";
import { browser, installApiProbe, apiCalls, sleep } from "./frontend-harness.mjs";

export async function run(run, check) {
	const search = (await run.jsonApi("/api/search")).body;
	assert.equal(search.available, false, "the fixture unexpectedly has a search engine");
	assert.ok(search.reason, "the search status carries no reason");

	await check("research settings: keyless Research stays interactive, writes its boolean, search engine stays gated", async () => {
		const page = browser(run, "research-settings");
		try {
			await page.goto("/", { ready: 'textarea' });
			page.press("Control+,");
			await page.waitForJs(`!!document.querySelector('[data-testid=settings-dialog]')`, 8_000, "settings dialog");
			page.click('[data-testid="settings-nav-agent"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=tool-row-research]')`, 8_000, "research row");
			installApiProbe(page);

			const initial = page.js(`(() => {
				const row = document.querySelector('[data-testid=tool-row-research]');
				const toggle = document.querySelector('[data-testid=toggle-tool-research]');
				const engine = document.querySelector('[data-testid=search-engine-trigger]');
				return {
					rowText: row.innerText,
					rowClass: row.className,
					disabled: toggle.disabled,
					checked: toggle.getAttribute('aria-checked'),
					engineClass: engine.className,
					engineRowText: document.querySelector('[data-testid=search-engine-row]').innerText,
					engineMenu: !!document.querySelector('[data-testid=search-engine-menu]'),
				};
			})()`);
			assert.equal(initial.disabled, false, "keyless Research toggle is disabled");
			assert.equal(initial.checked, "true", "the fixture research tool is not on");
			assert.ok(!initial.rowClass.includes("opacity-40"), "the Research row is dimmed by the missing search key");
			assert.ok(!initial.rowText.includes(search.reason), "the search reason leaks into the Research row as a disable hint");
			assert.ok(initial.engineClass.includes("cursor-not-allowed"), "the search-engine trigger lost its key gate");
			assert.ok(initial.engineRowText.includes(search.reason), "the search-engine row lost the reason hint");
			assert.equal(initial.engineMenu, false, "the search-engine menu was open before any click");

			page.click('[data-testid="toggle-tool-research"]');
			await page.waitForJs(`document.querySelector('[data-testid=toggle-tool-research]').getAttribute('aria-checked') === 'false'`, 5_000, "research toggle off");
			const deadline = Date.now() + 8_000;
			let saved;
			while (Date.now() < deadline) {
				saved = (await run.jsonApi("/api/settings")).body.settings;
				if (saved?.agent?.tools?.research === false) break;
				await sleep(150);
			}
			assert.equal(saved?.agent?.tools?.research, false, "the research toggle was not persisted");
			assert.equal(saved?.agent?.tools?.explain, false, "the write dropped the other agent tool overrides");
			const writes = apiCalls(page).filter((call) => call.method === "PUT" && call.pathname === "/api/settings/agent");
			assert.equal(writes.length, 1, `expected one agent settings write, saw ${writes.length}`);
			const body = JSON.parse(writes[0].body);
			assert.equal(body.tools.research, false, "the write body did not carry the stored boolean");
			assert.equal(body.tools.explain, false, "the write body lost the untouched tool override");

			page.js(`document.querySelector('[data-testid=search-engine-trigger]').scrollIntoView({ block: 'center' })`);
			await sleep(300);
			page.click('[data-testid="search-engine-trigger"]');
			await sleep(700);
			assert.equal(page.exists('[data-testid="search-engine-menu"]'), false, "the keyless search-engine preference opened its menu");
			assert.equal(page.exists('[data-testid="settings-dialog"]'), true, "clicking the gated engine trigger closed settings");
			assert.ok((await page.q('[data-testid="search-engine-row"]')).includes(search.reason), "the reason hint disappeared after the click");
			const settingsWrites = apiCalls(page).filter((call) => call.method !== "GET" && call.pathname.startsWith("/api/settings"));
			page.screenshot("research-01-keyless-gate");
			assert.equal(settingsWrites.length, 1, `the gated engine click wrote settings: ${JSON.stringify(settingsWrites)}`);
			page.press("Escape");
			await page.waitForJs(`!document.querySelector('[data-testid=settings-dialog]')`, 5_000, "settings closed");
			return { reason: search.reason, writes: settingsWrites.length };
		} finally {
			page.close();
		}
	});
}
