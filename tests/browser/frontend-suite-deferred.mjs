/**
 * Browser-deferred stateful contracts the cleanup ledger left to a real
 * browser: inline session rename, coverage-ring body, populated graph chrome,
 * chain row expansion + search, practice-draft action row geometry.
 */
import assert from "node:assert/strict";
import { browser, initScript, installApiProbe, apiCalls, sleep } from "./frontend-harness.mjs";
import { SEEDED_CHAT } from "./frontend-suite-model-picker.mjs";

const ROW = '[data-testid="session-row"]';
const GROUPS = '[data-testid^="cluster-group-"]';

/** Cluster rows and (when expanded) their chain counts, read from the live
 *  table. A thread guide can precede the row; the label/count/date spans are
 *  the row's direct span children. */
function readGroups(page) {
	return page.js(`(() => [...document.querySelectorAll(${JSON.stringify(GROUPS)})].map((group) => {
		const row = group.querySelector(':scope > div.flex');
		const spans = [...row.querySelectorAll(':scope > span')];
		const chains = [...group.querySelectorAll('[data-testid^="chain-row-"]')].map((chainRow) => {
			const cells = [...chainRow.querySelectorAll(':scope > span')];
			return { id: chainRow.getAttribute('data-testid').replace('chain-row-', ''), count: Number(cells.at(-2)?.innerText) };
		});
		return {
			key: group.getAttribute('data-testid').replace('cluster-group-', ''),
			label: spans.at(-3)?.innerText ?? null,
			count: Number(spans.at(-2)?.innerText),
			date: spans.at(-1)?.innerText ?? null,
			chains,
		};
	}))()`);
}

function assertMonotonic(values, direction, what) {
	for (let i = 1; i < values.length; i += 1) {
		const ok = direction === "desc" ? values[i - 1] >= values[i] : values[i - 1] <= values[i];
		assert.ok(ok, `${what} is not ${direction} at ${i}: ${JSON.stringify(values)}`);
	}
}

/** The first singleton chain row (one member) currently rendered, or null. */
function readSingleton(page) {
	return page.js(`(() => {
		for (const row of document.querySelectorAll('[data-testid^="chain-row-"]')) {
			const count = Number([...row.querySelectorAll(':scope > span')].at(-2)?.innerText);
			if (count !== 1) continue;
			return {
				id: row.getAttribute('data-testid').replace('chain-row-', ''),
				chips: row.querySelectorAll('[data-testid^="prop-chip-"]').length,
				ands: row.querySelectorAll('[data-testid^="chain-and-"]').length,
				implies: row.querySelectorAll('[data-testid^="chain-implies-"]').length,
				aria: row.getAttribute('aria-label'),
				visible: row.innerText,
			};
		}
		return null;
	})()`);
}

/** A labelled legacy `/api/keys` body: no `providers` roster (the pre-roster
 *  wire shape). Served only to the page, before hydration; the server and its
 *  real key route are untouched. */
export function legacyKeysScript(keys) {
	return `(() => {
		const keysBody = ${JSON.stringify(JSON.stringify({ keys }))};
		const custom = JSON.stringify({ keyPresent: false });
		window.__legacyKeys = { keysReads: 0, customReads: 0 };
		const original = window.fetch;
		window.fetch = function (input, init) {
			const raw = typeof input === "string" ? input : (input && input.url) || "";
			let pathname = raw;
			try { pathname = new URL(raw, location.href).pathname; } catch {}
			if (pathname === "/api/keys") {
				window.__legacyKeys.keysReads += 1;
				return Promise.resolve(new Response(keysBody, { status: 200, headers: { "content-type": "application/json" } }));
			}
			if (pathname === "/api/custom-endpoint") {
				window.__legacyKeys.customReads += 1;
				return Promise.resolve(new Response(custom, { status: 200, headers: { "content-type": "application/json" } }));
			}
			return original.apply(this, arguments);
		};
	})();`;
}

const KEY = (id, info) => ({ id, info, present: true, masked: "…legacy", source: "file", shadowedByEnv: false });

export async function run(run, check) {
	await check("deferred: inline rename keeps the row geometry, commits once and persists", async () => {
		const page = browser(run, "deferred-rename");
		try {
			await page.goto(`/chat/${SEEDED_CHAT}`, { ready: ROW });
			const originalTitle = page.js(`document.querySelectorAll(${JSON.stringify(ROW)})[0].innerText.split("\\n")[0]`);
			assert.ok(originalTitle, "no sidebar session title to rename");
			const chats = (await run.jsonApi("/api/chats")).body.chats;
			const target = chats.find((chat) => chat.title === originalTitle);
			assert.ok(target, `no API chat matches the sidebar title ${JSON.stringify(originalTitle)}`);
			installApiProbe(page);
			const box = page.box(ROW);
			page.move(Math.round(box.x + 40), Math.round(box.y + box.height / 2));
			page.down("right");
			page.up("right");
			await page.waitForJs(`!!document.querySelector('[data-testid=session-context-menu]')`, 5_000, "session context menu");
			page.click('[data-testid="ctx-rename"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=session-rename-input]')`, 5_000, "inline rename input");
			const draft = page.js(`(() => {
				const input = document.querySelector('[data-testid=session-rename-input]');
				const row = document.querySelector('[data-testid=session-rename-row]');
				return {
					value: input.value,
					className: input.className,
					meta: row.querySelector('.block.text-xs')?.innerText ?? null,
					height: row.getBoundingClientRect().height,
				};
			})()`);
			assert.equal(draft.value, originalTitle, "the draft did not start from the current title");
			assert.ok(draft.className.includes("px-0"), "the rename input lost its zero left padding");
			assert.ok(draft.className.includes("border-b"), "the underline editing cue is gone");
			assert.ok(draft.className.includes("bg-transparent"), "the rename input gained a filled box");
			assert.ok(!draft.className.includes("bg-background"), "the rename input gained a filled box");
			assert.ok(draft.meta && draft.meta.length > 0, "the meta line did not ride along");

			const nextTitle = "Synthetic rename probe";
			page.fill('[data-testid="session-rename-input"]', nextTitle);
			page.press("Enter");
			await page.waitForJs(`!document.querySelector('[data-testid=session-rename-input]')`, 8_000, "rename committed");
			await page.waitForJs(`[...document.querySelectorAll(${JSON.stringify(ROW)})].some((row) => row.innerText.includes(${JSON.stringify(nextTitle)}))`, 8_000, "sidebar shows the new title");
			const stored = await run.getChat(target.id);
			assert.equal(stored.title, nextTitle, "the rename was not persisted");
			const writes = apiCalls(page).filter((call) => call.method === "PUT" && call.pathname === `/api/chats/${target.id}`);
			assert.equal(writes.length, 1, `expected one rename write, saw ${JSON.stringify(writes)}`);
			assert.deepEqual(JSON.parse(writes[0].body), { title: nextTitle }, "the rename body drifted");
			page.screenshot("deferred-01-rename");
			return { originalTitle, nextTitle, chatId: target.id };
		} finally {
			page.close();
		}
	});

	await check("deferred: coverage ring renders a non-empty meter and its popover body", async () => {
		const page = browser(run, "deferred-coverage");
		try {
			await page.goto(`/chat/${SEEDED_CHAT}`, { ready: '[data-testid="coverage-ring"]' });
			const closed = page.js(`({
				expanded: document.querySelector('[data-testid=coverage-ring]').getAttribute('aria-expanded'),
				popover: !!document.querySelector('[data-testid=coverage-ring-popover]'),
				dash: [...document.querySelectorAll('[data-testid=coverage-ring] circle')].at(-1)?.getAttribute('stroke-dasharray') ?? null,
			})`);
			assert.equal(closed.expanded, "false", "the coverage ring started expanded");
			assert.equal(closed.popover, false, "the coverage popover was mounted before any click");
			assert.ok(closed.dash, "the coverage ring has no progress arc");
			assert.ok(Number.parseFloat(closed.dash) > 0, `the coverage ring arc is empty: ${closed.dash}`);
			page.click('[data-testid="coverage-ring"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=coverage-ring-popover]')`, 5_000, "coverage popover");
			const body = await page.q('[data-testid="coverage-ring-popover"]');
			for (const label of ["extraction coverage", "uncovered", "covered", "messages", "chunk threshold", "last extraction"]) {
				assert.ok(body.toLowerCase().includes(label), `coverage popover lost the ${label} line: ${JSON.stringify(body)}`);
			}
			assert.match(body, /\d/, "the coverage popover carries no numbers");
			page.press("Escape");
			await page.waitForJs(`!document.querySelector('[data-testid=coverage-ring-popover]')`, 5_000, "Escape closes only the coverage popover");
			assert.equal(page.exists('[data-testid="coverage-ring"]'), true, "Escape removed the coverage ring");
			assert.equal(page.exists('[data-testid="composer"] textarea'), true, "Escape removed the chat composer");
			page.screenshot("deferred-02-coverage-popover");
			return { dash: closed.dash, body: body.slice(0, 120) };
		} finally {
			page.close();
		}
	});

	await check("deferred: populated graph chrome renders all four controls and the no-match note", async () => {
		const page = browser(run, "deferred-graph-chrome");
		try {
			await page.goto("/", { ready: '[data-testid="import-notes"]' });
			const chrome = page.js(`({
				importNotes: !!document.querySelector('[data-testid=import-notes]'),
				search: [...document.querySelectorAll('input')].some((input) => input.placeholder === 'Search nodes…'),
				chains: !!document.querySelector('[data-testid=open-chain-table]'),
				settings: !!document.querySelector('[aria-label="Graph display settings"]'),
				fades: document.querySelectorAll('.graph-chrome-fade-in').length,
				noMatch: !!document.body.innerText.includes('No matching nodes.'),
			})`);
			assert.equal(chrome.importNotes, true, "Import Notes is missing on the populated graph");
			assert.equal(chrome.search, true, "the populated graph lost its node search");
			assert.equal(chrome.chains, true, "the populated graph lost the chains entry");
			assert.equal(chrome.settings, true, "the populated graph lost the display-settings gear");
			assert.equal(chrome.fades, 3, `gated controls lost the appear-once fade: ${chrome.fades}`);
			assert.equal(chrome.noMatch, false, "the no-match note rendered without a query");
			page.fill('input[placeholder="Search nodes…"]', "zzzz-no-such-node");
			await page.waitForJs(`document.body.innerText.includes('No matching nodes.')`, 5_000, "no-match note");
			page.fill('input[placeholder="Search nodes…"]', "");
			await page.waitForJs(`!document.body.innerText.includes('No matching nodes.')`, 5_000, "no-match note cleared");
			page.screenshot("deferred-03-graph-chrome");
			return chrome;
		} finally {
			page.close();
		}
	});

	await check("deferred: chain table expands clusters then chains, and search auto-expands matches", async () => {
		const page = browser(run, "deferred-chain-table");
		try {
			await page.goto("/", { ready: '[data-testid="open-chain-table"]' });
			page.click('[data-testid="open-chain-table"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=chain-table]')`, 5_000, "chain table");
			assert.equal(page.count('[data-testid^="chain-row-"]'), 0, "chain rows rendered before any cluster expanded");
			const cluster = page.js(`document.querySelector('[data-testid^="cluster-toggle-"]')?.getAttribute('data-testid') ?? null`);
			assert.ok(cluster, "no cluster row to expand");
			page.click(`[data-testid="${cluster}"]`);
			await page.waitForJs(`document.querySelectorAll('[data-testid^="chain-row-"]').length > 0`, 5_000, "chain row after cluster expand");
			const chain = page.js(`document.querySelector('[data-testid^="chain-toggle-"]')?.getAttribute('data-testid') ?? null`);
			assert.ok(chain, "no chain row to expand");
			const chainId = chain.replace("chain-toggle-", "");
			const label = page.js(`document.querySelector('[data-testid="chain-row-${chainId}"]')?.getAttribute('aria-label') ?? null`);
			assert.ok(label && label.length > 0, "the chain row carries no one-line derivation label");
			page.click(`[data-testid="${chain}"]`);
			await page.waitForJs(`document.querySelectorAll('[data-testid^="prop-row-"]').length > 0`, 5_000, "statement rows after chain expand");
			assert.equal(page.js(`document.querySelector('[data-testid="${chain}"]').getAttribute('aria-expanded')`), "true", "the chain expander did not report expanded");

			page.click('[data-testid="chain-table-close"]');
			await page.waitForJs(`!document.querySelector('[data-testid=chain-table]')`, 5_000, "chain table closed");
			await page.reload({ ready: '[data-testid="open-chain-table"]' });
			page.click('[data-testid="open-chain-table"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=chain-table]')`, 5_000, "chain table reopened");
			assert.equal(page.count('[data-testid^="chain-row-"]'), 0, "a freshly mounted table kept a previous expansion");
			page.fill('[data-testid="chain-table-search"]', "Primary key");
			await page.waitForJs(`document.querySelectorAll('[data-testid^="chain-row-"]').length > 0`, 5_000, "search auto-expanded matching chains");
			assert.equal(page.exists('[data-testid="chain-table-nomatch"]'), false, "a matching search reported no match");
			page.fill('[data-testid="chain-table-search"]', "zzzz-no-such-chain");
			await page.waitForJs(`!!document.querySelector('[data-testid=chain-table-nomatch]')`, 5_000, "chain no-match note");
			page.screenshot("deferred-04-chain-table");
			return { chainId, label: label.slice(0, 100) };
		} finally {
			page.close();
		}
	});

	await check("deferred: chain sort controls reorder clusters and chains for all three columns", async () => {
		const page = browser(run, "deferred-chain-sort");
		try {
			await page.goto("/", { ready: '[data-testid="open-chain-table"]' });
			page.click('[data-testid="open-chain-table"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=chain-table]')`, 5_000, "chain table");
			const defaultSort = page.js(`({
				name: document.querySelector('[data-testid=sort-name]').getAttribute('aria-sort'),
				props: document.querySelector('[data-testid=sort-props]').getAttribute('aria-sort'),
				created: document.querySelector('[data-testid=sort-created]').getAttribute('aria-sort'),
			})`);
			assert.deepEqual(defaultSort, { name: "ascending", props: "none", created: "none" }, "the default name ascending state drifted");
			const defaultChevrons = page.js(`(() => ({
				name: !!document.querySelector('[data-testid=sort-name] svg'),
				props: !!document.querySelector('[data-testid=sort-props] svg'),
				created: !!document.querySelector('[data-testid=sort-created] svg'),
			}))()`);
			assert.deepEqual(defaultChevrons, { name: true, props: false, created: false }, "only the active sort header may carry a chevron");

		// Expand the largest cluster so every sort assertion has chain rows too.
		const before = readGroups(page);
		const largest = [...before].sort((a, b) => b.count - a.count)[0];
		assert.ok(largest && largest.count > 1, "no populated cluster to expand");
		page.click(`[data-testid="cluster-toggle-${largest.key}"]`);
		await page.waitForJs(`document.querySelectorAll('[data-testid^="chain-row-"]').length > 0`, 5_000, "chain rows after cluster expand");

		page.click('[data-testid="sort-props"]');
		await page.waitForJs(`document.querySelector('[data-testid=sort-props]').getAttribute('aria-sort') === 'descending'`, 5_000, "props descending");
		assert.equal(page.js(`!!document.querySelector('[data-testid=sort-props] svg')`), true, "the descending props header lost its chevron");
		assert.equal(page.js(`!!document.querySelector('[data-testid=sort-name] svg')`), false, "the inactive name header kept its chevron");
		let groups = readGroups(page);
		assertMonotonic(groups.map((group) => group.count), "desc", "cluster proposition counts");
		const largestGroup = groups.find((group) => group.key === largest.key);
		assert.ok(largestGroup && largestGroup.chains.length > 1, "the expanded cluster has no chain comparison set");
		assertMonotonic(largestGroup.chains.map((chain) => chain.count), "desc", "chain proposition counts");

		page.click('[data-testid="sort-props"]');
		await page.waitForJs(`document.querySelector('[data-testid=sort-props]').getAttribute('aria-sort') === 'ascending'`, 5_000, "props ascending");
		groups = readGroups(page);
		assertMonotonic(groups.map((group) => group.count), "asc", "cluster proposition counts");
		assertMonotonic(readGroups(page).find((group) => group.key === largest.key).chains.map((chain) => chain.count), "asc", "chain proposition counts");

		page.click('[data-testid="sort-created"]');
		await page.waitForJs(`document.querySelector('[data-testid=sort-created]').getAttribute('aria-sort') === 'descending'`, 5_000, "created descending");
		groups = readGroups(page);
		assertMonotonic(
			groups.map((group) => group.date).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)),
			"desc",
			"cluster newest dates",
		);

		page.click('[data-testid="sort-name"]');
		await page.waitForJs(`document.querySelector('[data-testid=sort-name]').getAttribute('aria-sort') === 'ascending'`, 5_000, "name ascending");
		assert.equal(page.js(`document.querySelector('[data-testid=sort-props]').getAttribute('aria-sort')`), "none", "the props header stayed marked after switching columns");
		assert.equal(page.js(`document.querySelector('[data-testid=sort-created]').getAttribute('aria-sort')`), "none", "the created header stayed marked after switching columns");
		assert.ok(readGroups(page).length > 1, "name sort dropped the cluster rows");
		page.screenshot("deferred-06-chain-sort");
		return { largest: largest.key, groups: groups.length };
		} finally {
			page.close();
		}
	});

	await check("deferred: chain selection summary, clear, search persistence and fenced delete confirmation", async () => {
		const page = browser(run, "deferred-chain-selection");
		try {
			await page.goto("/", { ready: '[data-testid="open-chain-table"]' });
			page.click('[data-testid="open-chain-table"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=chain-table]')`, 5_000, "chain table");
			assert.equal(page.exists('[data-testid="chain-selection-bar"]'), false, "the selection bar rendered with no selection");
			assert.equal(page.exists('[data-testid="chain-delete"]'), false, "the delete control rendered with no selection");

			const cluster = readGroups(page)[0];
			assert.ok(cluster && cluster.count > 0, "no cluster to select");
			page.click(`[data-testid="cluster-checkbox-${cluster.key}"]`);
			await page.waitForJs(`!!document.querySelector('[data-testid=chain-selection-bar]')`, 5_000, "selection bar");
			const summary = page.q('[data-testid="chain-selected-summary"]');
			assert.match(summary, new RegExp(`^${cluster.count} nodes → \\d+ chains?$`), `the derived selection summary drifted: ${summary}`);
			assert.ok(
				page.js(`(() => { const divider = document.querySelector('[data-testid=chain-danger-divider]'); const del = document.querySelector('[data-testid=chain-delete]'); return !!divider && divider.compareDocumentPosition(del) === Node.DOCUMENT_POSITION_FOLLOWING; })()`),
				"the destructive fence no longer precedes Delete",
			);

			// Old contract: the floating bar is never search-filtered.
			page.fill('[data-testid="chain-table-search"]', "Primary key");
			await page.waitForJs(`document.querySelectorAll('[data-testid^="chain-row-"]').length > 0`, 5_000, "search rows");
			assert.equal(page.q('[data-testid="chain-selected-summary"]'), summary, "search filtered the selection bar");
			page.fill('[data-testid="chain-table-search"]', "");

			page.click('[data-testid="chain-clear"]');
			await page.waitForJs(`!document.querySelector('[data-testid=chain-selection-bar]')`, 5_000, "Clear removed the bar");

			let group = readGroups(page)[0];
			page.click(`[data-testid="cluster-toggle-${group.key}"]`);
			await page.waitForJs(`!!document.querySelector('[data-testid^="chain-checkbox-"]')`, 5_000, "chain checkbox");
			// The singleton law: a premise without its conclusion becomes a singleton.
			let chain = page.js(`(() => {
				for (const row of document.querySelectorAll('[data-testid^="chain-row-"]')) {
					const count = Number([...row.querySelectorAll(':scope > span')].at(-2)?.innerText);
					if (count !== 2) continue;
					const id = row.getAttribute('data-testid').replace('chain-row-', '');
					const conclusion = [...row.querySelectorAll('[data-testid^="prop-chip-"]')].at(-1)?.getAttribute('data-testid').replace('prop-chip-', '');
					return { id, count, conclusion };
				}
				return null;
			})()`);
			if (!chain) {
				group = readGroups(page).find((entry) => entry.count > 1);
				page.click(`[data-testid="cluster-toggle-${group.key}"]`);
				await page.waitForJs(`!!document.querySelector('[data-testid^="chain-checkbox-"]')`, 5_000, "second cluster chain checkbox");
				chain = page.js(`(() => {
					for (const row of document.querySelectorAll('[data-testid^="chain-row-"]')) {
						const count = Number([...row.querySelectorAll(':scope > span')].at(-2)?.innerText);
						if (count !== 2) continue;
						const id = row.getAttribute('data-testid').replace('chain-row-', '');
						const conclusion = [...row.querySelectorAll('[data-testid^="prop-chip-"]')].at(-1)?.getAttribute('data-testid').replace('prop-chip-', '');
						return { id, count, conclusion };
					}
					return null;
				})()`);
			}
			assert.ok(chain, "no two-member chain to exercise the singleton law");
			page.click(`[data-testid="chain-checkbox-${chain.id}"]`);
			await page.waitForJs(`!!document.querySelector('[data-testid=chain-selection-bar]')`, 5_000, "chain selection bar");
			const chainSummary = page.q('[data-testid="chain-selected-summary"]');
			assert.equal(chainSummary, `${chain.count} nodes → 1 chain`, "a fully selected chain did not derive as one chain");

			page.click(`[data-testid="chain-toggle-${chain.id}"]`);
			await page.waitForJs(`!!document.querySelector('[data-testid="prop-checkbox-${chain.conclusion}"]')`, 5_000, "conclusion statement row");
			page.click(`[data-testid="prop-checkbox-${chain.conclusion}"]`);
			await page.waitForJs(`document.querySelector('[data-testid=chain-selected-summary]')?.innerText === '1 node → 1 chain'`, 5_000, "premise-only singleton");

			page.click('[data-testid="chain-delete"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=delete-node-dialog]')`, 5_000, "delete confirmation");
			const confirmation = page.js(`({
				title: document.querySelector('[data-testid=delete-node-dialog] h2').innerText,
				names: document.querySelector('[data-testid=node-names-code], [data-testid=node-name-code]')?.innerText ?? null,
				permanence: document.querySelector('[data-testid=node-permanence-line]').innerText,
				confirm: document.querySelector('[data-testid=node-delete-confirm]').innerText,
			})`);
			assert.equal(confirmation.title, "Delete node?", "the single-node delete confirmation copy drifted");
			assert.equal(confirmation.permanence, "This permanently deletes the node — this cannot be undone.", "the single-node permanence copy drifted");
			assert.ok(confirmation.names && confirmation.names.length > 0, "the confirmation named no selected node");
			assert.equal(confirmation.confirm, "Delete", "the confirmation action drifted");
			page.click('[data-testid="node-delete-cancel"]');
			await page.waitForJs(`!document.querySelector('[data-testid=delete-node-dialog]')`, 5_000, "Cancel closed the confirmation");
			assert.equal(page.q('[data-testid="chain-selected-summary"]'), "1 node → 1 chain", "cancelling the confirmation lost the selection");
			page.click('[data-testid="chain-clear"]');
			page.screenshot("deferred-07-chain-selection");
			return { cluster: cluster.count, summary, chain: chainSummary, singleton: "1 node → 1 chain", confirmation: confirmation.title };
		} finally {
			page.close();
		}
	});

	await check("deferred: chain Delete keeps the old counted accessible name", async () => {
		const page = browser(run, "deferred-chain-delete-label");
		try {
			await page.goto("/", { ready: '[data-testid="open-chain-table"]' });
			page.click('[data-testid="open-chain-table"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=chain-table]')`, 5_000, "chain table");
			const cluster = readGroups(page)[0];
			page.click(`[data-testid="cluster-toggle-${cluster.key}"]`);
			await page.waitForJs(`!!document.querySelector('[data-testid^="chain-checkbox-"]')`, 5_000, "chain checkbox");
			const chain = page.js(`(() => { const row = document.querySelector('[data-testid^="chain-row-"]'); return { id: row.getAttribute('data-testid').replace('chain-row-', ''), count: Number([...row.querySelectorAll(':scope > span')].at(-2)?.innerText) }; })()`);
			page.click(`[data-testid="chain-checkbox-${chain.id}"]`);
			await page.waitForJs(`!!document.querySelector('[data-testid=chain-delete]')`, 5_000, "chain Delete");
			const label = page.js(`document.querySelector('[data-testid=chain-delete]').getAttribute('aria-label')`);
			assert.equal(label, `Delete ${chain.count} selected ${chain.count === 1 ? "node" : "nodes"}`, "the Delete accessible name lost the old selected-count contract");
			page.screenshot("deferred-09-chain-delete-label");
			return { count: chain.count, label };
		} finally {
			page.close();
		}
	});

	await check("deferred: expanded chain rows keep the baseline framing, chip, connector and singleton visuals", async () => {
		const page = browser(run, "deferred-chain-visuals");
		try {
			await page.goto("/", { ready: '[data-testid="open-chain-table"]' });
			page.click('[data-testid="open-chain-table"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=chain-table]')`, 5_000, "chain table");
			const first = readGroups(page).find((group) => group.count > 1) ?? readGroups(page)[0];
			assert.ok(first, "no cluster to expand");
			assert.equal(page.count('[data-testid^="cluster-thread-"]'), 0, "a cluster thread rendered before any cluster expanded");
			assert.equal(page.count('[data-testid^="chain-thread-"]'), 0, "a chain thread rendered before any chain expanded");
			page.click(`[data-testid="cluster-toggle-${first.key}"]`);
			await page.waitForJs(`document.querySelectorAll('[data-testid^="chain-row-"]').length > 0`, 5_000, "chain rows after cluster expand");

			// Baseline tree threads (owner rounds 5-6): one hairline at the
			// cluster expander's column, bracketed inside the expanded group.
			const clusterThread = page.js(`(() => {
				const group = document.querySelector('[data-testid="cluster-group-${first.key}"]');
				const guide = document.querySelector('[data-testid="cluster-thread-${first.key}"]');
				if (!group || !guide) return { exists: false };
				const box = guide.getBoundingClientRect();
				const groupBox = group.getBoundingClientRect();
				const toggle = document.querySelector('[data-testid="cluster-toggle-${first.key}"]').getBoundingClientRect();
				const style = getComputedStyle(guide);
				return {
					exists: true,
					left: box.left - groupBox.left,
					top: box.top - groupBox.top,
					bottom: groupBox.bottom - box.bottom,
					width: box.width,
					height: box.height,
					centerOffset: Math.abs(box.left + box.width / 2 - (toggle.left + toggle.width / 2)),
					background: style.backgroundColor,
					pointerEvents: style.pointerEvents,
					ariaHidden: guide.getAttribute('aria-hidden'),
				};
			})()`);
			assert.equal(clusterThread.exists, true, "the expanded cluster lost its baseline tree thread");
			assert.equal(page.count('[data-testid^="cluster-thread-"]'), 1, "the collapsed clusters rendered tree threads");
			assert.equal(page.count('[data-testid^="chain-thread-"]'), 0, "a chain thread rendered before any chain expanded");
			assert.equal(clusterThread.left, 37, `the cluster thread left the expander column: ${clusterThread.left}`);
			assert.equal(clusterThread.top, 23, `the cluster thread lost its top bracket: ${clusterThread.top}`);
			assert.equal(clusterThread.bottom, 9, `the cluster thread lost its bottom bracket (8px above the padding edge): ${clusterThread.bottom}`);
			assert.equal(clusterThread.width, 1, `the cluster thread is not a hairline: ${clusterThread.width}`);
			assert.ok(clusterThread.height > 0, "the cluster thread has no visible height");
			assert.ok(clusterThread.centerOffset <= 1, `the cluster thread is off the expander column: ${clusterThread.centerOffset}`);
			assert.notEqual(clusterThread.background, "rgba(0, 0, 0, 0)", "the cluster thread is transparent");
			assert.notEqual(clusterThread.background, "transparent", "the cluster thread is transparent");
			assert.equal(clusterThread.pointerEvents, "none", "the cluster thread can intercept clicks");
			assert.equal(clusterThread.ariaHidden, "true", "the decorative cluster thread is exposed to assistive tech");

			// THE STANDARD TOP BAR: 60px, the drag band, no select, and the
			// counts alone (the serif title names sessions; this overlay has none).
			const topBar = page.js(`(() => {
				const bar = document.querySelector('[data-testid=chain-table] header');
				const style = getComputedStyle(bar);
				return {
					height: Number.parseFloat(style.height),
					drag: bar.classList.contains('lh-drag'),
					selectNone: bar.classList.contains('select-none'),
					text: bar.innerText.replace(/\\n+/g, ' ').trim(),
					close: !!bar.querySelector('[data-testid=chain-table-close]'),
					search: !!bar.querySelector('[data-testid=chain-table-search]'),
				};
			})()`);
			assert.equal(topBar.height, 60, `the top bar lost its 60px band: ${topBar.height}`);
			assert.equal(topBar.drag, true, "the top bar lost the window-drag band");
			assert.equal(topBar.selectNone, true, "dragging the top bar would highlight its text");
			assert.match(topBar.text, /^\d+ chains? · \d+ nodes?$/, `the top bar grew a title or lost its counts: ${JSON.stringify(topBar.text)}`);
			assert.equal(topBar.close, true, "the top bar lost its close X");
			assert.equal(topBar.search, true, "the top bar lost its node search");

			// THE FRAMING: the header carries the top rule, every cluster group
			// carries its bottom rule, and individual rows stay lineless at the
			// staircase indent (pl-12 = the cluster folder's column).
			const framing = page.js(`(() => {
				const header = document.querySelector('[data-testid=chain-table] .sticky');
				const groups = [...document.querySelectorAll('[data-testid^="cluster-group-"]')];
				const row = document.querySelector('[data-testid^="chain-row-"]');
				const style = getComputedStyle(row);
				return {
					headerRule: Number.parseFloat(getComputedStyle(header).borderBottomWidth),
					groupRules: groups.map((group) => Number.parseFloat(getComputedStyle(group).borderBottomWidth)),
					folderIcons: groups.every((group) => [...group.querySelectorAll('svg')].some((svg) => !svg.closest('[data-testid^="cluster-toggle-"]'))),
					notesTag: groups.some((group) => [...group.querySelectorAll('span')].some((span) => span.textContent.trim() === 'notes' && getComputedStyle(span).textTransform === 'uppercase')),
					rowRule: Number.parseFloat(style.borderBottomWidth),
					rowPaddingLeft: Number.parseFloat(style.paddingLeft),
					rowPaddingRight: Number.parseFloat(style.paddingRight),
				};
			})()`);
			assert.ok(framing.headerRule > 0, "the table header lost its top rule");
			assert.ok(framing.groupRules.length > 0 && framing.groupRules.every((width) => width > 0), "a cluster group lost its bottom rule");
			assert.equal(framing.folderIcons, true, "a cluster row lost its folder icon slot");
			assert.equal(framing.notesTag, true, "a notes-sourced cluster lost its NOTES tag");
			assert.equal(framing.rowRule, 0, "a chain row grew a border line");
			assert.equal(framing.rowPaddingLeft, 48, "the chain row lost its staircase indent");
			assert.equal(framing.rowPaddingRight, 12, "the chain row lost its right gutter");

			const chain = page.js(`(() => {
				const rows = [...document.querySelectorAll('[data-testid^="chain-row-"]')].map((row) => ({
					id: row.getAttribute('data-testid').replace('chain-row-', ''),
					count: Number([...row.querySelectorAll(':scope > span')].at(-2)?.innerText),
				}));
				return rows.sort((a, b) => b.count - a.count)[0] ?? null;
			})()`);
			assert.ok(chain && chain.count >= 2, `no multi-member chain to inspect: ${JSON.stringify(chain)}`);
			const visuals = page.js(`(() => {
				const row = document.querySelector('[data-testid="chain-row-${chain.id}"]');
				const chips = [...row.querySelectorAll('[data-testid^="prop-chip-"]')];
				const ands = [...row.querySelectorAll('[data-testid^="chain-and-"]')];
				const implies = [...row.querySelectorAll('[data-testid^="chain-implies-"]')];
				const probe = (className) => {
					const span = document.createElement('span');
					span.className = className;
					document.body.append(span);
					const color = getComputedStyle(span).color;
					span.remove();
					return color;
				};
				const chip = getComputedStyle(chips[0]);
				return {
					chips: chips.length,
					ands: ands.map((node) => node.innerText),
					implies: implies.map((node) => node.innerText),
					connectorColor: ands.length > 0 ? getComputedStyle(ands[0]).color : null,
					foreground: probe('text-foreground'),
					muted: probe('text-muted-foreground'),
					chipBorderWidth: Number.parseFloat(chip.borderTopWidth),
					chipBorderStyle: chip.borderTopStyle,
					chipBackground: chip.backgroundColor,
					strayIcons: [...row.querySelectorAll('svg')].filter((svg) => !svg.closest('[data-testid^="chain-toggle-"]')).length,
					visibleText: row.innerText,
				};
			})()`);
			assert.equal(visuals.chips, chain.count, `the chain line lost chips: ${visuals.chips}/${chain.count}`);
			assert.deepEqual(visuals.ands, Array(chain.count - 2).fill("∧"), `the premise connects drifted: ${JSON.stringify(visuals.ands)}`);
			assert.deepEqual(visuals.implies, ["⟹"], `the conclusion connective drifted: ${JSON.stringify(visuals.implies)}`);
			assert.equal(visuals.connectorColor, visuals.foreground, "the connectives lost the prominent theme foreground");
			assert.notEqual(visuals.connectorColor, visuals.muted, "the connectives read as dim gray");
			assert.equal(visuals.chipBorderWidth, 1, "the proposition chips lost their outline");
			assert.equal(visuals.chipBorderStyle, "solid", "the proposition chips lost their outline style");
			assert.notEqual(visuals.chipBackground, "rgba(0, 0, 0, 0)", "the proposition chips lost their muted tint");
			assert.equal(visuals.strayIcons, 0, "a chain row grew a decorative icon beside its expander");
			assert.equal(visuals.visibleText.includes("→"), false, "a textual arrow connector remained visible");

			// One click deeper: plain statement rows at the double-column indent,
			// no conclusion marker, and the 14x20 expander column.
			page.click(`[data-testid="chain-toggle-${chain.id}"]`);
			await page.waitForJs(`document.querySelectorAll('[data-testid^="prop-row-"]').length > 0`, 5_000, "statement rows");

			// The chain's own thread: the same bracket law one level down, at
			// the chain expander's column inside the expanded chain block.
			const chainThread = page.js(`(() => {
				const block = document.querySelector('[data-testid="chain-block-${chain.id}"]');
				const guide = document.querySelector('[data-testid="chain-thread-${chain.id}"]');
				if (!block || !guide) return { exists: false };
				const box = guide.getBoundingClientRect();
				const blockBox = block.getBoundingClientRect();
				const toggle = document.querySelector('[data-testid="chain-toggle-${chain.id}"]').getBoundingClientRect();
				const style = getComputedStyle(guide);
				return {
					exists: true,
					left: box.left - blockBox.left,
					top: box.top - blockBox.top,
					bottom: blockBox.bottom - box.bottom,
					width: box.width,
					height: box.height,
					centerOffset: Math.abs(box.left + box.width / 2 - (toggle.left + toggle.width / 2)),
					background: style.backgroundColor,
					pointerEvents: style.pointerEvents,
					ariaHidden: guide.getAttribute('aria-hidden'),
				};
			})()`);
			assert.equal(chainThread.exists, true, "the expanded chain lost its baseline tree thread");
			assert.equal(page.count('[data-testid^="chain-thread-"]'), 1, "a collapsed chain rendered a tree thread");
			assert.equal(chainThread.left, 73, `the chain thread left the expander column: ${chainThread.left}`);
			assert.equal(chainThread.top, 22, `the chain thread lost its top bracket: ${chainThread.top}`);
			assert.equal(chainThread.bottom, 8, `the chain thread lost its bottom bracket: ${chainThread.bottom}`);
			assert.equal(chainThread.width, 1, `the chain thread is not a hairline: ${chainThread.width}`);
			assert.ok(chainThread.height > 0, "the chain thread has no visible height");
			assert.ok(chainThread.centerOffset <= 1, `the chain thread is off the expander column: ${chainThread.centerOffset}`);
			assert.notEqual(chainThread.background, "rgba(0, 0, 0, 0)", "the chain thread is transparent");
			assert.notEqual(chainThread.background, "transparent", "the chain thread is transparent");
			assert.equal(chainThread.pointerEvents, "none", "the chain thread can intercept clicks");
			assert.equal(chainThread.ariaHidden, "true", "the decorative chain thread is exposed to assistive tech");
			const statements = page.js(`(() => {
				const rows = [...document.querySelectorAll('[data-testid^="prop-row-"]')];
				const style = getComputedStyle(rows[0]);
				const box = document.querySelector('[data-testid="chain-toggle-${chain.id}"]').getBoundingClientRect();
				return {
					rows: rows.length,
					text: rows[0].innerText.trim().length,
					paddingLeft: Number.parseFloat(style.paddingLeft),
					conclusionMarkers: document.querySelectorAll('[data-testid*="prop-conclusion"]').length,
					expanderWidth: Math.round(box.width),
					expanderHeight: Math.round(box.height),
				};
			})()`);
			assert.equal(statements.rows, chain.count, `the expanded chain revealed ${statements.rows}/${chain.count} statement rows`);
			assert.ok(statements.text > 0, "a statement row rendered no statement text");
			assert.equal(statements.paddingLeft, 84, "statement rows lost the double-column indent");
			assert.equal(statements.conclusionMarkers, 0, "a conclusion marker appeared on the plain statement rows");
			assert.equal(statements.expanderWidth, 14, "the chain expander lost the checkbox-width column");
			assert.equal(statements.expanderHeight, 20, "the chain expander lost its 20px height");

			// THE SINGLETON LAW: one lonely chip, no connectors, and the
			// "(no premises)" annotation only in the row's accessible name.
			let singleton = readSingleton(page);
			for (const group of singleton ? [] : readGroups(page).filter((entry) => entry.key !== first.key)) {
				page.click(`[data-testid="cluster-toggle-${group.key}"]`);
				await page.waitForJs(`document.querySelectorAll('[data-testid^="chain-row-"]').length > 0`, 5_000, "chain rows for the singleton sweep");
				singleton = readSingleton(page);
				if (singleton) break;
			}
			assert.ok(singleton, "no singleton chain row rendered across the expanded clusters");
			assert.equal(singleton.chips, 1, `a singleton rendered ${singleton.chips} chips`);
			assert.equal(singleton.ands, 0, "a singleton rendered a premise connective");
			assert.equal(singleton.implies, 0, "a singleton rendered a conclusion connective");
			assert.match(singleton.aria ?? "", /\(no premises\)$/, `the singleton accessible name drifted: ${singleton.aria}`);
			assert.equal(singleton.visible.includes("(no premises)"), false, "the singleton annotation became visible text");

			page.screenshot("deferred-10-chain-visuals");
			return { chain: chain.id, members: chain.count, singleton: singleton.id, framing, statements, topBar, threads: { cluster: clusterThread, chain: chainThread } };
		} finally {
			page.close();
		}
	});

	await check("deferred: practice picker selection persists across close/reopen and swaps Delete for Done", async () => {
		const page = browser(run, "deferred-practice-picker");
		try {
			await page.goto("/chat/new?mode=practice", { ready: '[data-testid="practice-props-chip"]' });
			page.click('[data-testid="practice-props-chip"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=chain-table]')`, 8_000, "practice chain picker");
			const cluster = readGroups(page)[0];
			assert.ok(cluster && cluster.count > 0, "the practice picker has no cluster to select");
			page.click(`[data-testid="cluster-checkbox-${cluster.key}"]`);
			await page.waitForJs(`!!document.querySelector('[data-testid=chain-practice-done]')`, 5_000, "Done in the practice bar");
			const summary = page.q('[data-testid="chain-selected-summary"]');
			assert.match(summary, new RegExp(`^${cluster.count} nodes → \\d+ chains?$`), `the practice summary drifted: ${summary}`);
			assert.equal(page.exists('[data-testid="chain-delete"]'), false, "the practice picker exposed Delete");
			assert.equal(page.exists('[data-testid="chain-danger-divider"]'), false, "the practice picker exposed the delete fence");
			page.click('[data-testid="chain-practice-done"]');
			await page.waitForJs(`!document.querySelector('[data-testid=chain-table]')`, 5_000, "Done closed the picker");
			const chip = page.q('[data-testid="practice-props-chip"]');
			assert.ok(chip.includes(`${cluster.count} nodes selected`), `the composer chip did not reflect the pick: ${chip}`);
			assert.equal(page.exists('[data-testid="practice-props-clear"]'), true, "the picked draft has no Clear");

			page.click('[data-testid="practice-props-chip"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=chain-table]')`, 8_000, "reopened practice picker");
			assert.equal(page.q('[data-testid="chain-selected-summary"]'), summary, "the reopened picker lost the selected context");
			page.click('[data-testid="chain-table-close"]');
			await page.waitForJs(`!document.querySelector('[data-testid=chain-table]')`, 5_000, "picker closed");
			assert.ok(page.q('[data-testid="practice-props-chip"]').includes(`${cluster.count} nodes selected`), "closing the picker lost the picks");
			page.click('[data-testid="practice-props-clear"]');
			await page.waitForJs(`document.querySelector('[data-testid=practice-props-chip]').innerText.includes('Pick nodes')`, 5_000, "Clear reset the picker chip");
			page.screenshot("deferred-08-practice-picker");
			return { cluster: cluster.count, summary, chip };
		} finally {
			page.close();
		}
	});

	await check("deferred: practice draft action row is ordered, left-aligned and flush with the composer", async () => {
		const page = browser(run, "deferred-composer-geometry");
		try {
			await page.goto("/chat/new?mode=practice", { ready: '[data-testid="composer-actions"]' });
			const geometry = page.js(`(() => {
				const row = document.querySelector('[data-testid=composer-actions]');
				const composer = document.querySelector('[data-testid=composer]');
				const chip = document.querySelector('[data-testid=practice-props-chip]');
				const rowBox = row.getBoundingClientRect();
				const composerBox = composer.getBoundingClientRect();
				return {
					justify: getComputedStyle(row).justifyContent,
					wrap: row.className.includes('flex-wrap'),
					pointer: row.className.includes('pointer-events-auto'),
					chipText: chip?.innerText.trim() ?? null,
					chipAccessibleIcon: chip?.querySelector('[aria-hidden="true"]')?.textContent ?? null,
					chipInFirstGroup: chip?.parentElement?.parentElement === row,
					clear: !!document.querySelector('[data-testid=practice-props-clear]'),
					rowLeft: rowBox.left,
					composerLeft: composerBox.left,
					rowBottom: rowBox.bottom,
					composerTop: composerBox.top,
					rows: document.querySelectorAll('[data-testid=composer-actions]').length,
				};
			})()`);
			assert.equal(geometry.rows, 1, "the draft rendered more than one action row");
			assert.equal(geometry.justify, "flex-start", "the practice action row is not left-aligned");
			assert.equal(geometry.wrap, true, "the action row lost its wrapping");
			assert.equal(geometry.pointer, true, "the action row lost pointer-events-auto");
			assert.ok(geometry.chipText.includes("Pick nodes"), "the practice picker chip copy drifted");
			assert.equal(geometry.chipAccessibleIcon, "◎", "the picker glyph is no longer aria-hidden");
			assert.equal(geometry.chipInFirstGroup, true, "the picker chip is not the row's leading group");
			assert.equal(geometry.clear, false, "Clear rendered with no selection");
			assert.ok(Math.abs(geometry.rowLeft - geometry.composerLeft) <= 1, `the row is not flush with the composer: ${geometry.rowLeft} vs ${geometry.composerLeft}`);
			assert.ok(geometry.rowBottom <= geometry.composerTop + 1, "the action row is not above the composer");
			page.screenshot("deferred-05-composer-geometry");
			return geometry;
		} finally {
			page.close();
		}
	});

	await check("deferred: a legacy /api/keys body without a provider roster classifies by key id", async () => {
		const cases = [
			{ name: "provider", keys: [KEY("OPENROUTER_API_KEY", { label: "OpenRouter", envVar: "OPENROUTER_API_KEY" })], zero: false },
			{ name: "tool", keys: [KEY("DEEPGRAM_API_KEY", { label: "Deepgram", envVar: "DEEPGRAM_API_KEY" })], zero: true },
			{ name: "generic", keys: [KEY("LEGACY_UNKNOWN_KEY", null)], zero: false },
		];
		const observed = {};
		for (const entry of cases) {
			const page = browser(run, `deferred-legacy-keys-${entry.name}`, { initScript: initScript(run, `legacy-keys-${entry.name}`, legacyKeysScript(entry.keys)) });
			try {
				await page.goto("/", { ready: "textarea" });
				await page.waitForJs("window.__legacyKeys.keysReads >= 1 && window.__legacyKeys.customReads >= 1", 8_000, "the intercepted key reads landed");
				await sleep(400);
				const cta = page.exists('[data-testid="setup-cta-keys"]');
				const reads = page.js("({ keys: window.__legacyKeys.keysReads, custom: window.__legacyKeys.customReads })");
				assert.ok(reads.keys >= 1 && reads.custom >= 1, `the legacy fixture was not read: ${JSON.stringify(reads)}`);
				assert.equal(cta, entry.zero, `legacy body ${entry.name} produced zeroKeys=${cta}, expected ${entry.zero}`);
				observed[entry.name] = { cta, reads };
			} finally {
				page.close();
			}
		}
		return observed;
	});
}
