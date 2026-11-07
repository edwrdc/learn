import assert from "node:assert/strict";
import { browser, initScript } from "./frontend-harness.mjs";

const DISPATCH_CHAT = "chat_mv27rrra_feff23b6";
const RESEARCH_CALL = "call_1aea81f5790445238d9d37abe258635c";
const PDF_CALL = "call_63f708f61cec40a9b45c45dafb5af687";

const CARDS = '[data-testid="dispatch-card"],[data-testid="dispatch-settled"],[data-testid="dispatch-refused"]';
const MODELS_REFUSAL = "No model configured — set up your models first (missing: cheap)";
const KEY_REFUSAL = "No OpenRouter key is set — add one in Settings → Keys";

function cardTexts(page) {
	return page.js(`[...document.querySelectorAll(${JSON.stringify(CARDS)})].map((node) => node.innerText.replace(/\\s+/g, ' ').trim())`);
}

function findCard(texts, label, state) {
	return texts.some((text) => text.toLowerCase().includes(label.toLowerCase()) && text.toLowerCase().includes(state.toLowerCase()));
}

/** Return scripted job lists from /api/jobs and expose the hub's reconnect
 *  hook, so a poll can be forced without waiting for an SSE frame. */
function jobsGateScript() {
	return `(() => {
	const Native = window.EventSource;
	const control = (window.__lhJobs = { jobs: [] });
	control.set = (jobs) => { control.jobs = jobs; };
	const nativeFetch = window.fetch.bind(window);
	window.fetch = function (input, init) {
		const raw = typeof input === "string" ? input : (input && input.url) || "";
		let pathname = raw;
		try { pathname = new URL(raw, location.href).pathname; } catch {}
		if (pathname !== "/api/jobs") return nativeFetch(input, init);
		return Promise.resolve(new Response(JSON.stringify({ jobs: control.jobs, turnInFlight: false }), { status: 200, headers: { "content-type": "application/json" } }));
	};
	window.EventSource = class extends Native {
		constructor(...args) {
			super(...args);
			let open = null;
			Object.defineProperty(this, "onopen", {
				configurable: true,
				get: () => open,
				set: (fn) => { open = fn; },
			});
			control.fireResync = () => { if (open) open.call(this, new Event("open")); };
		}
	};
})();`;
}

const job = (over) => ({
	id: "job_dispatch_probe",
	kind: "research",
	chatId: DISPATCH_CHAT,
	toolCallId: RESEARCH_CALL,
	status: "running",
	activity: "web_search: synthetic activity",
	createdAt: new Date(Date.now() - 5000).toISOString(),
	updatedAt: new Date().toISOString(),
	...over,
});

export async function run(run, check) {
	await check("dispatch: research and pdf cards settle from the recorded job list", async () => {
		const page = browser(run, "dispatch-recorded");
		try {
			await page.goto(`/chat/${DISPATCH_CHAT}`, { ready: '[data-testid="composer"] [data-testid="prose-field"]' });
			await page.waitForJs(
				`[...document.querySelectorAll(${JSON.stringify(CARDS)})].some((node) => node.innerText.includes("failed"))`,
				15_000,
				"the recorded jobs to reach the cards",
			);
			const texts = cardTexts(page);
			assert.ok(findCard(texts, "PDF reader", "failed"), `the pdf job did not reach its card: ${JSON.stringify(texts)}`);
			assert.ok(findCard(texts, "Research agent", "failed"), `the recorded research job did not reach its card: ${JSON.stringify(texts)}`);
			assert.ok(findCard(texts, "Research agent", "Dispatched"), `the call without a job stopped reading as pending: ${JSON.stringify(texts)}`);
			return texts;
		} finally {
			page.close();
		}
	});

	await check("dispatch: a refreshed job list re-renders research and pdf cards through running, delivered and refused", async () => {
		const page = browser(run, "dispatch-live", { initScript: initScript(run, "dispatch-live", jobsGateScript()) });
		try {
			await page.goto(`/chat/${DISPATCH_CHAT}`, { ready: '[data-testid="composer"] [data-testid="prose-field"]' });
			await page.waitForJs("!!window.__lhJobs?.fireResync", 10_000, "the jobs resync hook");
			page.js(`window.__lhJobs.set(${JSON.stringify([job({}), job({ id: "job_pdf_probe", kind: "pdf", toolCallId: PDF_CALL, activity: "pdf_render: 1-2 @150dpi" })])}); true`);
			page.js("window.__lhJobs.fireResync(); true");

			await page.waitForJs(`document.body.innerText.includes("web_search: synthetic activity")`, 15_000, "the running research activity");
			await page.waitForJs(`document.body.innerText.includes("pdf_render: 1-2 @150dpi")`, 15_000, "the running pdf activity");
			const running = cardTexts(page);
			assert.ok(findCard(running, "Research agent", "web_search: synthetic activity"), `the research activity did not render: ${JSON.stringify(running)}`);
			assert.ok(findCard(running, "PDF reader", "pdf_render: 1-2 @150dpi"), `the pdf activity did not render: ${JSON.stringify(running)}`);

			page.js(`window.__lhJobs.set(${JSON.stringify([job({ status: "done", activity: "delivered" }), job({ id: "job_pdf_probe", kind: "pdf", toolCallId: PDF_CALL, status: "done", activity: "delivered" })])}); window.__lhJobs.fireResync(); true`);
			await page.waitForJs(
				`[...document.querySelectorAll(${JSON.stringify(CARDS)})].filter((node) => node.innerText.includes("delivered")).length >= 2`,
				15_000,
				"both cards delivered after the refresh",
			);
			const done = cardTexts(page);
			assert.ok(findCard(done, "Research agent", "delivered"), `the research card did not settle: ${JSON.stringify(done)}`);
			assert.ok(findCard(done, "PDF reader", "delivered"), `the pdf card did not settle: ${JSON.stringify(done)}`);
			assert.ok(!findCard(done, "Research agent", "web_search: synthetic activity"), "the settled research card kept its activity line");
			assert.ok(findCard(done, "Research agent", "Dispatched"), `the call without a job stopped reading as pending: ${JSON.stringify(done)}`);

			page.js(`window.__lhJobs.set(${JSON.stringify([
				job({ status: "error", error: MODELS_REFUSAL }),
				job({ id: "job_pdf_probe", kind: "pdf", toolCallId: PDF_CALL, status: "error", error: KEY_REFUSAL }),
			])}); window.__lhJobs.fireResync(); true`);
			await page.waitForJs(`document.body.innerText.includes("needs model setup")`, 15_000, "the research refusal");
			await page.waitForJs(`document.body.innerText.includes("needs a provider key")`, 15_000, "the pdf refusal");
			const refused = cardTexts(page);
			assert.ok(findCard(refused, "Research agent", "needs model setup"), `the research refusal did not render: ${JSON.stringify(refused)}`);
			assert.ok(findCard(refused, "PDF reader", "needs a provider key"), `the pdf refusal did not render: ${JSON.stringify(refused)}`);
			assert.equal(page.count('[data-testid="dispatch-setup-link"]'), 2, "the refusal cards lost their setup links");
			assert.ok(!refused.some((text) => text.toLowerCase().includes("research agent") && text.toLowerCase().includes("failed")), `a refusal read as a failure: ${JSON.stringify(refused)}`);
			return { running, done, refused };
		} finally {
			page.close();
		}
	});
}
