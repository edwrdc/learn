/**
 * Residual render contracts the coverage audit left unported (old
 * tests/render-minimal-home.test.tsx, tests/render-activity-dock.test.tsx,
 * tests/render-extraction-coverage.test.tsx).
 *
 * The activity feed and the session coverage reads are served by page-level
 * API-boundary fixtures (the old render tests passed the same objects as
 * props). Every fixture uses the shipped wire shapes — ActivityJob /
 * ActivityExtraction and SessionCoverage — and is labelled as a fixture, not
 * a live extraction claim. The populated minimal home uses the real golden
 * graph through the shipped mode switch (Settings > Graph > Graph rendering
 * off), so no fixture stands in for the counts.
 */
import assert from "node:assert/strict";
import { browser, initScript, installApiProbe, apiCalls } from "./frontend-harness.mjs";
import { SEEDED_CHAT } from "./frontend-suite-model-picker.mjs";

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/** The shipped user path into the no-graph home. Idempotent: reads the
 *  stored toggle first, so a rerun or a failed earlier check still lands
 *  the page in the minimal branch. */
async function ensureMinimalHome(page) {
	page.click('[data-testid="settings-entry"]');
	await page.waitForJs(`!!document.querySelector('[data-testid=settings-dialog]')`, 8_000, "settings dialog");
	page.click('[data-testid="settings-nav-graph"]');
	await page.waitForJs(`!!document.querySelector('[data-testid=toggle-graph-rendering-enabled]')`, 8_000, "graph rendering row");
	if (page.js(`document.querySelector('[data-testid=toggle-graph-rendering-enabled]').getAttribute('aria-checked')`) === "true") {
		page.click('[data-testid="toggle-graph-rendering-enabled"]');
		await page.waitForJs(
			`document.querySelector('[data-testid=toggle-graph-rendering-enabled]').getAttribute('aria-checked') === 'false'`,
			8_000,
			"graph rendering off persisted",
		);
	}
	assert.equal(page.exists('[data-testid="settings-error"]'), false, "the graph settings write reported an error");
	page.click('[data-testid="settings-close"]');
	await page.waitForJs(`!document.querySelector('[data-testid=settings-dialog]')`, 5_000, "settings closed");
}

/** Page boundary: the activity dock's one poll answers with the fixture feed
 *  (ActivityJob[] + ActivityExtraction[], the /api/activity shape). */
export function activityFeedScript(feed) {
	return `(() => {
		window.__activityFixture = { reads: 0 };
		const body = ${JSON.stringify(JSON.stringify(feed))};
		const original = window.fetch;
		window.fetch = function (input, init) {
			const raw = typeof input === "string" ? input : (input && input.url) || "";
			let pathname = raw;
			try { pathname = new URL(raw, location.href).pathname; } catch {}
			if (pathname !== "/api/activity") return original.apply(this, arguments);
			window.__activityFixture.reads += 1;
			return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
		};
	})();`;
}

/** Page boundary: the per-session coverage read (SessionCoverage) rides the
 *  real chat GET, so the transcript keeps loading while the meter state is
 *  controlled. The manual Extract POST answers 409 from the fixture: the
 *  optimistic branch renders and the server never starts a run. */
export function coverageScript(initial) {
	return `(() => {
		window.__coverageFixture = ${JSON.stringify(initial)};
		window.__coverageCalls = { reads: 0, paths: [], extractPosts: 0, bodies: [] };
		const original = window.fetch;
		window.fetch = function (input, init) {
			const raw = typeof input === "string" ? input : (input && input.url) || "";
			let pathname = raw;
			try { pathname = new URL(raw, location.href).pathname; } catch {}
			const method = (init && init.method) || "GET";
			if (method === "GET" && /^\\/api\\/chats\\/[^/]+$/.test(pathname)) {
				return original.apply(this, arguments).then(async (res) => {
					if (!res.ok) return res;
					const body = await res.json();
					window.__coverageCalls.reads += 1;
					window.__coverageCalls.paths.push(pathname);
					return new Response(JSON.stringify({ ...body, coverage: window.__coverageFixture }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				});
			}
			if (method === "POST" && pathname === "/api/graph/coverage/extract") {
				window.__coverageCalls.extractPosts += 1;
				window.__coverageCalls.bodies.push(init && typeof init.body === "string" ? init.body : null);
				return Promise.resolve(new Response(JSON.stringify({ error: "fixture: extraction starts nothing" }), {
					status: 409,
					headers: { "content-type": "application/json" },
				}));
			}
			return original.apply(this, arguments);
		};
	})();`;
}

/** The old fixture's SessionCoverage shape: 5 messages unextracted, 2k
 *  uncovered tokens, 7/12 covered, a 4096-token budget. */
const COVERAGE_UNCOVERED = {
	totalMessages: 12,
	coveredCount: 7,
	uncoveredCount: 5,
	coveredTokens: 30_000,
	uncoveredTokens: 2_048,
	running: false,
	lastFoldedAt: null,
};
const COVERAGE_FULL = { ...COVERAGE_UNCOVERED, uncoveredCount: 0, uncoveredTokens: 0, lastFoldedAt: "2026-09-24T10:00:00Z" };
const COVERAGE_RUNNING = { ...COVERAGE_UNCOVERED, running: true };

async function openSessionMenu(page, expected) {
	const box = page.box('[data-testid="session-row"]');
	assert.ok(box, "no sidebar session row to open the context menu from");
	page.move(Math.round(box.x + 40), Math.round(box.y + box.height / 2));
	page.down("right");
	page.up("right");
	await page.waitForJs(`!!document.querySelector('[data-testid=ctx-coverage]')`, 8_000, expected);
}

function readMenu(page) {
	return page.js(`(() => {
		const block = document.querySelector('[data-testid=ctx-coverage]');
		const extract = document.querySelector('[data-testid=ctx-extract]');
		return {
			text: block?.innerText ?? null,
			running: !!document.querySelector('[data-testid=ctx-coverage-running]'),
			extractText: extract?.innerText ?? null,
			extractDisabled: extract ? extract.disabled : null,
		};
	})()`);
}

export async function run(run, check) {
	await check("coverage: populated minimal home renders one line per count with true plurals and no empty hint", async () => {
		const page = browser(run, "coverage-minimal-home");
		try {
			await page.goto("/", { ready: '[data-testid="settings-entry"]' });
			await ensureMinimalHome(page);
			await page.goto("/", { ready: '[data-testid="knowledge-summary"]' });

			const graph = (await run.jsonApi("/api/graph")).body;
			const chats = (await run.jsonApi("/api/chats")).body.chats;
			const expected = [
				plural(graph.propositions.length, "proposition", "propositions"),
				plural(graph.chains.length, "chain", "chains"),
				plural(chats.filter((chat) => chat.kind === "teach").length, "teaching session", "teaching sessions"),
				plural(chats.filter((chat) => chat.kind === "practice").length, "practice session", "practice sessions"),
				plural(Object.keys(graph.fileSources).length, "imported note", "imported notes"),
			];
			assert.ok(graph.propositions.length > 0 && graph.chains.length > 0, "the golden graph is empty; the populated contract needs data");
			await page.waitForJs(
				`document.querySelector('[data-testid=knowledge-summary]').innerText.includes(${JSON.stringify(expected[0])})`,
				8_000,
				"populated count lines",
			);

			const summary = page.js(`(() => {
				const node = document.querySelector('[data-testid=knowledge-summary]');
				const lines = [...node.querySelectorAll('p')].map((p) => p.innerText.trim());
				const spacers = [...node.querySelectorAll(':scope > div.h-4')];
				return {
					lines,
					dotSeparators: node.innerText.includes(' · '),
					emptyHint: node.innerText.includes('Nothing here yet'),
					spacers: spacers.length,
					spacerHeights: spacers.map((s) => getComputedStyle(s).height),
					spacerHidden: spacers.every((s) => s.getAttribute('aria-hidden') === 'true'),
					chainButton: !!document.querySelector('[data-testid=open-chain-table]'),
					nodeSearch: !!document.querySelector('input[placeholder="Search nodes…"]'),
				};
			})()`);
			assert.deepEqual(summary.lines, expected, "the summary lines drifted from the live counts");
			assert.equal(summary.dotSeparators, false, "a dot separator joined two counts");
			assert.equal(summary.emptyHint, false, "the populated home kept the empty-state hint");
			assert.equal(summary.spacers, 2, "the graph/sessions/notes blocks are not parted by two empty lines");
			assert.deepEqual(summary.spacerHeights, ["16px", "16px"], "the parting spacer lost its one-empty-line height");
			assert.equal(summary.spacerHidden, true, "a decorative spacer is exposed to assistive tech");
			assert.equal(summary.chainButton, true, "the minimal home lost the chain table entry");
			assert.equal(summary.nodeSearch, false, "the graph canvas chrome rendered instead of the minimal home");
			page.screenshot("coverage-01-minimal-home");
			return { lines: summary.lines, spacers: summary.spacers };
		} finally {
			page.close();
		}
	});

	await check("coverage: activity dock renders an extraction row with money/context dashes and the priced total", async () => {
		const now = Date.now();
		const usage = {
			model: "openrouter:z-ai/glm-5.3-flash",
			inputTokens: 10_000,
			outputTokens: 1_000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			steps: 1,
		};
		const job = (id, ago) => ({
			id,
			kind: "demo",
			chatId: "c1",
			toolCallId: `t-${id}`,
			status: "running",
			activity: "building sandbox…",
			createdAt: new Date(now - ago).toISOString(),
			updatedAt: new Date(now - 1_000).toISOString(),
			title: "Chain-rule demo",
			contextLimit: null,
			usage,
		});
		const feed = {
			jobs: [job("j-a", 30_000), job("j-b", 20_000)],
			extractions: [{ id: "cx", chatId: "cx", title: "Old lesson", phase: "merging", startedAt: now - 45_000 }],
			graphRevision: 0,
		};
		const page = browser(run, "coverage-activity", { initScript: initScript(run, "activity-fixture", activityFeedScript(feed)) });
		try {
			await page.goto(`/chat/${SEEDED_CHAT}`, { ready: '[data-testid="activity-section"]' });
			await page.waitForJs(`!!document.querySelector('[data-testid=activity-blob-extraction]')`, 8_000, "extraction activity row");
			const state = page.js(`(() => {
				const extraction = document.querySelector('[data-testid=activity-blob-extraction]');
				const cell = (row, testid) => row.querySelector('[data-testid=' + testid + ']')?.innerText ?? null;
				return {
					jobs: document.querySelectorAll('[data-testid=activity-blob-job]').length,
					extractions: document.querySelectorAll('[data-testid=activity-blob-extraction]').length,
					header: document.querySelector('[data-testid=activity-section]').innerText.split('\\n')[0],
					extractionText: extraction.innerText,
					extractionCost: cell(extraction, 'activity-blob-cost'),
					extractionElapsed: cell(extraction, 'activity-blob-elapsed'),
					extractionAbort: extraction.querySelector('[data-testid=activity-abort]').getAttribute('aria-label'),
					jobCosts: [...document.querySelectorAll('[data-testid=activity-blob-job] [data-testid=activity-blob-cost]')].map((node) => node.innerText),
					total: document.querySelector('[data-testid=activity-total-cost]')?.innerText ?? null,
				};
			})()`);
			assert.equal(state.jobs, 2, `the dock rendered ${state.jobs} job rows`);
			assert.equal(state.extractions, 1, "the dock did not render the extraction process");
			assert.match(state.header ?? "", /background agents/i, `the dock header drifted: ${JSON.stringify(state.header)}`);
			assert.ok(state.extractionText.includes("Old lesson"), `the extraction row lost its title: ${state.extractionText}`);
			assert.ok(state.extractionText.includes("Extraction — merging"), `the extraction row lost its phase label: ${state.extractionText}`);
			assert.equal(state.extractionCost, "—", `an extraction row carries no money: ${state.extractionCost}`);
			assert.match(state.extractionElapsed, /^\d+s$/, `the extraction row lost its elapsed clock: ${state.extractionElapsed}`);
			assert.equal(state.extractionAbort, "End Extraction — merging in Old lesson", "the extraction END lost its accessible name");
			assert.deepEqual(state.jobCosts, ["$0.0020", "$0.0020"], `the priced jobs drifted: ${JSON.stringify(state.jobCosts)}`);
			assert.equal(state.total, "$0.0040", `the priced total drifted: ${state.total}`);

			page.click('[data-testid="activity-blob-extraction"] > button:first-child');
			await page.waitForJs(`!!document.querySelector('[data-testid=activity-blob-detail]')`, 5_000, "extraction detail");
			const detail = page.js(`(() => {
				const node = document.querySelector('[data-testid=activity-blob-detail]');
				return {
					text: node.innerText,
					context: node.querySelector('[data-testid=activity-blob-context]').innerText,
					link: node.querySelector('a')?.getAttribute('href') ?? null,
					expanded: document.querySelector('[data-testid=activity-blob-extraction] > button:first-child').getAttribute('aria-expanded'),
				};
			})()`);
			assert.ok(detail.text.includes("Extraction — merging"), `the detail lost the extraction label: ${detail.text}`);
			assert.ok(detail.text.includes("Cost") && detail.text.includes("—"), "the extraction detail lost its dash-priced cost line");
			assert.equal(detail.context, "—", `an extraction has no context window: ${detail.context}`);
			assert.equal(detail.link, "/chat/cx", "the detail lost its session link");
			assert.equal(detail.expanded, "true", "the extraction row did not report the open detail");
			page.screenshot("coverage-02-activity-extraction");
			return { rows: state.jobs + state.extractions, total: state.total, extraction: state.extractionText.split("\n")[0] };
		} finally {
			page.close();
		}
	});

	await check("coverage: coverage menu body renders uncovered, fully extracted, running and optimistic states", async () => {
		const page = browser(run, "coverage-menu", { initScript: initScript(run, "coverage-menu-fixture", coverageScript(COVERAGE_UNCOVERED)) });
		try {
			await page.goto(`/chat/${SEEDED_CHAT}`, { ready: '[data-testid="session-row"]' });
			await openSessionMenu(page, "coverage menu block");
			let menu = readMenu(page);
			const uncoveredText = menu.text;
			assert.match(menu.text ?? "", /2k tok uncovered/, `the uncovered tokens drifted: ${menu.text}`);
			assert.match(menu.text ?? "", /5 messages unextracted/, `the uncovered message count drifted: ${menu.text}`);
			assert.equal(menu.running, false, "the idle menu reported an extraction in flight");
			assert.equal(menu.extractText, "Extract", "the idle affordance lost its Extract label");
			assert.equal(menu.extractDisabled, false, "an uncovered session cannot extract");

			page.press("Escape");
			await page.waitForJs(`!document.querySelector('[data-testid=ctx-coverage]')`, 5_000, "menu closed");
			page.js(`window.__coverageFixture = ${JSON.stringify(COVERAGE_FULL)}; true`);
			await page.waitForJs(`window.__coverageFixture.uncoveredTokens === 0`, 2_000, "fixture set to fully extracted");
			await openSessionMenu(page, "fully extracted menu block");
			await page.waitForJs(`document.querySelector('[data-testid=ctx-coverage]')?.innerText.includes('fully extracted')`, 5_000, "fully extracted line");
			menu = readMenu(page);
			assert.equal(menu.running, false, "the fully extracted menu reported a run");
			assert.equal(menu.extractDisabled, true, "a fully extracted session can still fire Extract");
			assert.equal(menu.extractText, "Extract", "the resting affordance lost its label");

			page.press("Escape");
			await page.waitForJs(`!document.querySelector('[data-testid=ctx-coverage]')`, 5_000, "menu closed again");
			page.js(`window.__coverageFixture = ${JSON.stringify(COVERAGE_RUNNING)}; true`);
			await page.waitForJs(`window.__coverageFixture.running === true`, 2_000, "fixture set to running");
			await openSessionMenu(page, "running menu block");
			await page.waitForJs(`!!document.querySelector('[data-testid=ctx-coverage-running]')`, 5_000, "running pulse line");
			menu = readMenu(page);
			assert.match(menu.text ?? "", /extracting…/, `the running line drifted: ${menu.text}`);
			assert.equal(menu.extractText, "Running", "the in-flight affordance no longer reads Running");
			assert.equal(menu.extractDisabled, true, "the in-flight affordance can double-fire");
			assert.equal(page.js(`!!document.querySelector('[data-testid=ctx-coverage-running] .animate-pulse')`), true, "the running line lost its pulse dot");

			page.press("Escape");
			await page.waitForJs(`!document.querySelector('[data-testid=ctx-coverage]')`, 5_000, "menu closed for the optimistic pass");
			page.js(`window.__coverageFixture = ${JSON.stringify(COVERAGE_UNCOVERED)}; true`);
			await openSessionMenu(page, "optimistic menu block");
			installApiProbe(page);
			page.click('[data-testid="ctx-extract"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=ctx-coverage-running]')`, 5_000, "optimistic running state");
			const optimistic = readMenu(page);
			assert.equal(optimistic.extractText, "Running", "the optimistic affordance did not flip to Running");
			assert.equal(optimistic.extractDisabled, true, "the optimistic affordance can double-fire");
			const posts = apiCalls(page).filter((call) => call.method === "POST" && call.pathname === "/api/graph/coverage/extract");
			assert.equal(posts.length, 1, `the Extract click wrote ${posts.length} POSTs`);
			const fixtureCalls = page.js("window.__coverageCalls");
			const body = JSON.parse(posts[0].body);
			assert.match(body.chatId ?? "", /^[A-Za-z0-9_]+$/, `the Extract body lost its chat id: ${posts[0].body}`);
			assert.ok(fixtureCalls.paths.includes(`/api/chats/${body.chatId}`), "the picked session's coverage read did not come from the fixture");
			assert.equal(fixtureCalls.extractPosts, 1, "the Extract click did not reach the page-boundary fixture");
			const feed = (await run.jsonApi("/api/activity")).body;
			assert.equal((feed.extractions ?? []).length, 0, "the fixture Extract click started a real server extraction");
			page.screenshot("coverage-03-coverage-menu");
			return { uncovered: uncoveredText?.split("\n").slice(0, 2), optimistic: optimistic.extractText, chatId: body.chatId };
		} finally {
			page.close();
		}
	});

	await check("coverage: coverage ring glyph renders half, empty and running states", async () => {
		const half = browser(run, "coverage-ring-half", { initScript: initScript(run, "coverage-half-fixture", coverageScript(COVERAGE_UNCOVERED)) });
		try {
			await half.goto(`/chat/${SEEDED_CHAT}`, { ready: '[data-testid="coverage-ring"]' });
			const glyph = half.js(`(() => {
				const button = document.querySelector('[data-testid=coverage-ring]');
				const svg = button.querySelector('svg');
				const arc = [...button.querySelectorAll('circle')].at(-1);
				const [dash, gap] = arc.getAttribute('stroke-dasharray').split(' ').map(Number);
				return {
					dash,
					gap,
					transform: arc.getAttribute('transform'),
					pulsing: svg.classList.contains('animate-pulse'),
					expanded: button.getAttribute('aria-expanded'),
				};
			})()`);
			const circumference = 2 * Math.PI * 6;
			assert.ok(Math.abs(glyph.gap - circumference) < 0.01, `the arc gap is not the ring circumference: ${glyph.gap}`);
			assert.ok(Math.abs(glyph.dash / circumference - 0.5) < 0.01, `2048/4096 did not fill half the ring: ${glyph.dash}`);
			assert.equal(glyph.transform, "rotate(-90 8 8)", "the arc no longer starts at twelve o'clock");
			assert.equal(glyph.pulsing, false, "a steady ring is pulsing");

			half.click('[data-testid="coverage-ring"]');
			await half.waitForJs(`!!document.querySelector('[data-testid=coverage-ring-popover]')`, 5_000, "coverage popover");
			const body = half.q('[data-testid="coverage-ring-popover"]');
			assert.ok(body.toLowerCase().includes("extraction coverage"), `the coverage popover lost its title: ${JSON.stringify(body)}`);
			for (const line of ["Uncovered", "2k tokens", "Covered", "30k tokens", "7 / 12", "Chunk threshold", "4.1k tokens", "Last extraction"]) {
				assert.ok(body.includes(line), `the coverage popover lost ${JSON.stringify(line)}: ${JSON.stringify(body)}`);
			}
			assert.match(body, /Last extraction[\s\S]*—/, "a missing fold rendered a fake timestamp");
			assert.equal(half.exists('[data-testid="coverage-ring-running"]'), false, "the idle popover reported a run");
			half.press("Escape");
			await half.waitForJs(`!document.querySelector('[data-testid=coverage-ring-popover]')`, 5_000, "Escape closed the popover");
			assert.equal(half.exists('[data-testid="coverage-ring"]'), true, "Escape removed the ring itself");
			half.screenshot("coverage-04-ring-half");
		} finally {
			half.close();
		}

		const empty = browser(run, "coverage-ring-empty", {
			initScript: initScript(run, "coverage-empty-fixture", coverageScript({ ...COVERAGE_UNCOVERED, uncoveredCount: 0, uncoveredTokens: 0 })),
		});
		try {
			await empty.goto(`/chat/${SEEDED_CHAT}`, { ready: '[data-testid="coverage-ring"]' });
			const dash = empty.js(`Number(document.querySelector('[data-testid=coverage-ring] circle:last-of-type').getAttribute('stroke-dasharray').split(' ')[0])`);
			assert.ok(dash < 0.01, `a fully extracted session drew an arc: ${dash}`);
			empty.screenshot("coverage-05-ring-empty");
		} finally {
			empty.close();
		}

		const running = browser(run, "coverage-ring-running", {
			initScript: initScript(run, "coverage-running-fixture", coverageScript(COVERAGE_RUNNING)),
		});
		try {
			await running.goto(`/chat/${SEEDED_CHAT}`, { ready: '[data-testid="coverage-ring"]' });
			assert.equal(running.js(`document.querySelector('[data-testid=coverage-ring] svg').classList.contains('animate-pulse')`), true, "the working ring is not pulsing");
			running.click('[data-testid="coverage-ring"]');
			await running.waitForJs(`!!document.querySelector('[data-testid=coverage-ring-running]')`, 5_000, "running status line");
			assert.match(running.q('[data-testid="coverage-ring-popover"]') ?? "", /extracting…/, "the running popover lost its status line");
			running.screenshot("coverage-06-ring-running");
			return { half: "0.5 arc", empty: "no arc", running: "pulse + status line" };
		} finally {
			running.close();
		}
	});
}
