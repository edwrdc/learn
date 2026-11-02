/**
 * Background-job activity dock (old tests/render-activity-dock.test.tsx): a
 * REAL research job is dispatched by a synthetic prober turn against the
 * loopback scripted provider (no web, no real model), held open long enough
 * to observe the running row, then aborted from the dock and, in a second
 * chat, allowed to finish. The row folds title/activity/elapsed/cost and
 * exposes the detail + END controls; removing the process removes the row.
 */
import assert from "node:assert/strict";
import { browser, installApiProbe, apiCalls, sleep } from "./frontend-harness.mjs";
import { RESEARCH_BRIEF } from "./frontend-mock-provider.mjs";

const ROW = '[data-testid="activity-blob-job"]';
const SECTION = '[data-testid="activity-section"]';

async function setTools(run, tools) {
	const settings = (await run.jsonApi("/api/settings")).body.settings;
	const { res, body } = await run.jsonApi("/api/settings/agent", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...settings.agent, tools: { ...(settings.agent?.tools ?? {}), ...tools } }),
	});
	assert.equal(res.status, 200, `agent settings → ${res.status} ${JSON.stringify(body)}`);
}

async function dispatchJob(page, run, tag) {
	await page.goto("/chat/new", { ready: '[data-testid="composer"] textarea' });
	page.fill('[data-testid="composer"] textarea', `Activity probe ${tag} [[MOCK:research:${tag}]]`);
	page.press("Enter");
	await page.waitForJs(`location.pathname.startsWith('/chat/') && location.pathname !== '/chat/new'`, 15_000, "chat route created");
	const chatId = page.js("location.pathname.split('/').at(-1)");
	const started = Date.now();
	let job;
	while (Date.now() - started < 20_000) {
		const feed = (await run.jsonApi("/api/activity")).body;
		job = (feed.jobs ?? []).find((entry) => entry.chatId === chatId);
		if (job) break;
		await sleep(150);
	}
	assert.ok(job, `no running job for ${chatId} reached /api/activity`);
	return { chatId, job, waitedMs: Date.now() - started };
}

/** The row for the one running job, scrolled into view. */
async function rowState(page) {
	await page.waitForJs(`!!document.querySelector(${JSON.stringify(ROW)})`, 8_000, "activity job row");
	return page.js(`(() => {
		const row = document.querySelector(${JSON.stringify(ROW)});
		row.scrollIntoView({ block: 'center' });
		const abort = row.querySelector('[data-testid=activity-abort]');
		return {
			rows: document.querySelectorAll('[data-testid="activity-blob-job"],[data-testid="activity-blob-extraction"]').length,
			text: row.innerText,
			elapsed: row.querySelector('[data-testid=activity-blob-elapsed]')?.innerText ?? null,
			cost: row.querySelector('[data-testid=activity-blob-cost]')?.innerText ?? null,
			titleAttr: row.querySelector('[title]')?.getAttribute('title') ?? null,
			abortLabel: abort?.getAttribute('aria-label') ?? null,
			abortTitle: abort?.getAttribute('title') ?? null,
			totalCost: document.querySelector('[data-testid=activity-total-cost]')?.innerText ?? null,
			section: !!document.querySelector(${JSON.stringify(SECTION)}),
			header: document.querySelector(${JSON.stringify(SECTION)})?.innerText.split('\\n')[0] ?? null,
		};
	})()`);
}

async function waitForRowGone(page, run, chatId) {
	await page.waitForJs(`!document.querySelector(${JSON.stringify(ROW)})`, 15_000, "activity row removed");
	const started = Date.now();
	let feed;
	while (Date.now() - started < 10_000) {
		feed = (await run.jsonApi("/api/activity")).body;
		if (!(feed.jobs ?? []).some((entry) => entry.chatId === chatId)) break;
		await sleep(150);
	}
	assert.ok(!(feed.jobs ?? []).some((entry) => entry.chatId === chatId), "the finished job stayed in /api/activity");
	return feed;
}

export async function run(run, check) {
	await setTools(run, { research: true, explain: false });

	await check("activity dock: a real research job row renders, opens its detail, and END aborts it out of the feed", async () => {
		const page = browser(run, "activity-abort");
		const tag = "ACTABORT";
		try {
			const { chatId, job, waitedMs } = await dispatchJob(page, run, tag);
			assert.equal(job.kind, "research", `the dispatch created a ${job.kind} job`);
			assert.equal(job.status, "running", "the observed job is not running");
			const chat = await run.getChat(chatId);
			const row = await rowState(page);
			assert.equal(row.section, true, "the always-present Background agents section is missing");
			assert.match(row.header ?? "", /background agents/i, `the dock header drifted: ${JSON.stringify(row.header)}`);
			assert.equal(row.rows, 1, `expected exactly one running-process blob, saw ${row.rows}`);
			assert.ok(row.text.includes(chat.title), `the row lost the chat title ${JSON.stringify(chat.title)}: ${JSON.stringify(row.text)}`);
			assert.ok(row.text.includes("researching"), `the row lost the runner's activity line: ${JSON.stringify(row.text)}`);
			assert.match(row.elapsed, /^\d+s$/, `the row lost its ticking elapsed time: ${row.elapsed}`);
			assert.equal(row.cost, "—", `an unpriced running job must read —, not ${row.cost}`);
			assert.equal(row.totalCost, "—", `the total-cost span must read — with no priced job: ${row.totalCost}`);
			assert.equal(row.titleAttr, "researching", "the activity line lost its native title (truncation reveal)");
			assert.ok(row.abortLabel?.startsWith("End Researcher in "), `the END control lost its accessible name: ${row.abortLabel}`);
			assert.equal(row.abortTitle, "End this background process", "the END control lost its tooltip");

			page.click(`${ROW} > button:first-child`);
			await page.waitForJs(`!!document.querySelector('[data-testid=activity-blob-detail]')`, 5_000, "activity detail popover");
			const detail = page.js(`(() => {
				const node = document.querySelector('[data-testid=activity-blob-detail]');
				return {
					text: node.innerText,
					context: node.querySelector('[data-testid=activity-blob-context]')?.innerText ?? null,
					abortStillThere: !!document.querySelector('[data-testid=activity-abort]'),
					expanded: document.querySelector(${JSON.stringify(ROW)} + ' button')?.getAttribute('aria-expanded') ?? null,
					openSession: !!node.querySelector('a'),
				};
			})()`);
			assert.equal(detail.expanded, "true", "the blob button did not report the open detail");
			assert.ok(detail.text.includes("Cost"), "the detail lost its cost line");
			assert.ok(detail.text.includes("Context"), "the detail lost its context line");
			assert.equal(detail.context, "—", `a running job with no usage must read — context, not ${detail.context}`);
			assert.equal(detail.openSession, true, "the detail lost its session link");
			assert.equal(detail.abortStillThere, true, "END is not popover-independent");

			const elapsedBefore = row.elapsed;
			await sleep(1_300);
			const ticked = page.js(`document.querySelector('[data-testid=activity-blob-elapsed]').innerText`);
			assert.notEqual(ticked, elapsedBefore, `the elapsed clock did not tick: ${elapsedBefore} -> ${ticked}`);

			installApiProbe(page);
			page.click('[data-testid="activity-abort"]');
			const started = Date.now();
			let aborts = [];
			while (Date.now() - started < 8_000) {
				aborts = apiCalls(page).filter((call) => call.pathname === "/api/activity/abort");
				if (aborts.length > 0) break;
				await sleep(100);
			}
			assert.equal(aborts.length, 1, `the END click wrote ${aborts.length} abort calls`);
			assert.equal(aborts[0].method, "POST", "the abort used a non-POST method");
			assert.deepEqual(JSON.parse(aborts[0].body), { kind: "job", id: job.id }, "the abort body drifted");

			const feed = await waitForRowGone(page, run, chatId);
			assert.equal(feed.jobs.length, 0, "another job appeared in the feed");
			const record = (await run.jsonApi(`/api/jobs?chatId=${chatId}`)).body.jobs.find((entry) => entry.id === job.id);
			assert.equal(record?.status, "error", `the aborted job is ${record?.status}`);
			assert.equal(record?.error, "Aborted by learner", "the aborted job lost the learner-abort reason");
			assert.equal(record?.activity, "aborted", "the aborted job kept a running activity line");
			const idle = await page.js(`({
				rows: document.querySelectorAll('[data-testid="activity-blob-job"],[data-testid="activity-blob-extraction"]').length,
				totalCost: !!document.querySelector('[data-testid=activity-total-cost]'),
				header: document.querySelector(${JSON.stringify(SECTION)})?.innerText.split('\\n')[0] ?? null,
			})`);
			assert.equal(idle.rows, 0, "the dock kept a row after the abort");
			assert.equal(idle.totalCost, false, "the total-cost span is decoration, not population");
			assert.match(idle.header ?? "", /background agents/i, "the idle dock lost its always-present header");

			const researcher = run.mock.requests.find((entry) => entry.tag === tag && entry.mode === "researchslow" && !entry.hasFunctionOutput);
			const started2 = Date.now();
			while (Date.now() - started2 < 5_000 && researcher && !researcher.aborted) await sleep(100);
			assert.ok(researcher?.aborted, "the researcher's provider stream was not aborted");
			page.screenshot("activity-01-aborted");
			return { jobId: job.id, waitedMs, elapsedBefore, ticked, researcher: { aborted: researcher?.aborted, segments: researcher?.segments } };
		} finally {
			page.close();
		}
	});

	await check("activity dock: a research job that finishes removes its row and settles the record", async () => {
		const page = browser(run, "activity-finish");
		const tag = "ACTDONE";
		try {
			const { chatId, job } = await dispatchJob(page, run, tag);
			const row = await rowState(page);
			assert.ok(row.text.includes("researching"), "the finishing job never showed a running row");

			const feed = await waitForRowGone(page, run, chatId);
			assert.equal(feed.jobs.length, 0, "the finished job stayed in the feed");
			const settled = (await run.waitSettled(chatId, 30_000));
			const record = (await run.jsonApi(`/api/jobs?chatId=${chatId}`)).body.jobs.find((entry) => entry.id === job.id);
			assert.equal(record?.status, "done", `the finished job is ${record?.status}`);
			assert.equal(record?.activity, "delivered", "the finished job lost its delivered activity");
			assert.ok(record?.result?.brief?.includes(RESEARCH_BRIEF), "the finished job lost the researcher brief");
			assert.ok(settled.messages.some((message) => message.role === "custom"), "the delivered brief never reached the chat record");
			assert.equal(page.js(`document.querySelectorAll('[data-testid="activity-blob-job"],[data-testid="activity-blob-extraction"]').length`), 0, "the dock kept the finished row");
			const researcher = run.mock.requests.find((entry) => entry.tag === tag && entry.mode === "researchslow" && !entry.hasFunctionOutput);
			assert.equal(researcher?.completed, true, "the researcher's provider stream never completed");
			page.screenshot("activity-02-finished");
			return { jobId: job.id, status: record.status, brief: record.result.brief.length, researcher: { completed: researcher?.completed, segments: researcher?.segments } };
		} finally {
			page.close();
		}
	});
}
