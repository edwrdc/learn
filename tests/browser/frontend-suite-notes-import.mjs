/**
 * Browser port of the old notes-import hook contract the cleanup ledger left
 * unported: a real hidden file input, the captured FormData, one POST while
 * pending, a second file event ignored, immediate error clearing, the error
 * projection, and onFinished-driven refresh. The POST reply is a labelled
 * API-boundary fixture (the old hook test stubbed fetch too); the real
 * HTTP/validation path is covered by the carrier smoke, not claimed here.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { browser, initScript, installApiProbe, apiCalls } from "./frontend-harness.mjs";

const INPUT = 'input[type="file"]';
const ALERT = '[role="alert"]';
const FIRST = "synthetic-notes.md";
const SECOND = "synthetic-notes-second.md";
const FIRST_TEXT = "Synthetic notes: the sky is blue.\n";
const SECOND_TEXT = "Synthetic second note that must never be posted.\n";

/** Pre-hydration page boundary: hold every /api/graph/import POST, record the
 *  real FormData, and reply only when the test releases it. */
export function notesImportScript() {
	return `(() => {
		const state = { requests: [], pending: [], reply: null, changes: 0 };
		window.__notesImport = state;
		document.addEventListener("change", (event) => {
			if (event.target instanceof HTMLInputElement && event.target.type === "file") state.changes += 1;
		}, true);
		const original = window.fetch;
		window.fetch = function (input, init) {
			const raw = typeof input === "string" ? input : (input && input.url) || "";
			let pathname = raw;
			try { pathname = new URL(raw, location.href).pathname; } catch {}
			if (pathname !== "/api/graph/import") return original.apply(this, arguments);
			const request = { method: (init && init.method) || "GET", files: [] };
			state.requests.push(request);
			const form = init && init.body;
			const files = form instanceof FormData ? form.getAll("files") : [];
			return Promise.all(files.map(async (file) => ({ name: file.name, type: file.type, text: await file.text() }))).then((captured) => {
				request.files = captured;
				return new Promise((resolve) => {
					const send = () => {
						const reply = state.reply;
						if (!reply) return;
						state.pending = state.pending.filter((entry) => entry !== send);
						resolve(new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } }));
					};
					state.pending.push(send);
				});
			});
		};
	})();`;
}

function upload(page, selector, files) {
	const result = spawnSync("agent-browser", ["--session", page.session, "upload", selector, ...files], {
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 10 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`agent-browser upload → ${result.status}\n${result.stdout}\n${result.stderr}`);
}

function reply(page, body, status = 200) {
	page.js(`window.__notesImport.reply = ${JSON.stringify({ body, status })}; window.__notesImport.pending.splice(0).forEach((send) => send()); true`);
}

const completed = (fileName) => ({ requestIndex: 0, filePath: fileName, ok: true, outcome: "completed", stats: { nodes: 2, chains: 1 } });
const refused = (fileName) => ({
	requestIndex: 0,
	filePath: fileName,
	ok: false,
	outcome: "failed",
	error: "No key is set",
	code: "provider_key_missing",
	provider: "openai",
	missing: ["OPENAI_API_KEY"],
	slots: ["cheap"],
});

export async function run(run, check) {
	await check("notes import: real file upload sends one POST, ignores a pending second event, shows the error, then reimports the same file", async () => {
		const fixtureDir = path.join(run.runDir, "notes-fixtures");
		fs.mkdirSync(fixtureDir, { recursive: true });
		const firstFile = path.join(fixtureDir, FIRST);
		const secondFile = path.join(fixtureDir, SECOND);
		fs.writeFileSync(firstFile, FIRST_TEXT);
		fs.writeFileSync(secondFile, SECOND_TEXT);

		const page = browser(run, "notes-import", {
			initScript: initScript(run, "notes-import-boundary", notesImportScript()),
		});
		try {
			await page.goto("/", { ready: '[data-testid="import-notes"]' });
			installApiProbe(page);
			assert.equal(page.count(ALERT), 0, "an untouched page already showed an import error");

			// The old contract: one POST carrying exactly the captured File, while pending.
			upload(page, INPUT, [firstFile]);
			await page.waitForJs("window.__notesImport.requests.length === 1 && window.__notesImport.requests[0].files.length === 1", 8_000, "first import POST");
			const first = page.js("window.__notesImport.requests[0]");
			assert.equal(first.method, "POST", "the import transport did not POST");
			assert.deepEqual(first.files, [{ name: FIRST, type: "text/markdown", text: FIRST_TEXT }], `captured FormData drifted: ${JSON.stringify(first.files)}`);
			assert.equal(page.js("document.querySelector('[data-testid=import-notes]').disabled"), true, "the import control stayed enabled while pending");
			assert.equal(page.q('[data-testid="import-notes"]'), "Importing…", "the pending label drifted");
			const count = (calls, pathname) => calls.filter((call) => call.method === "GET" && call.pathname === pathname).length;
			const before = apiCalls(page);

			// A second real file event while the first POST is unresolved is ignored.
			upload(page, INPUT, [secondFile]);
			await new Promise((resolve) => setTimeout(resolve, 700));
			assert.equal(page.js("window.__notesImport.requests.length"), 1, "a second file event started a second POST while pending");
			assert.equal(page.js("window.__notesImport.requests[0].files[0].name"), FIRST, "the pending request's file identity changed");
			assert.ok(page.js("window.__notesImport.changes") >= 2, "the second real file event never reached the input");
			assert.equal(count(apiCalls(page), "/api/graph"), count(before, "/api/graph"), "onFinished ran before the POST settled");
			assert.equal(count(apiCalls(page), "/api/graph/costs"), count(before, "/api/graph/costs"), "onFinished costs refresh ran before the POST settled");

			// Failure projection after settle; onFinished refreshes graph + costs.
			reply(page, { results: [refused(FIRST)] });
			await page.waitForJs(`document.querySelectorAll('[role=alert]').length === 1`, 8_000, "import error alert");
			const alertText = page.js("document.querySelector('[role=alert]').textContent");
			assert.equal(alertText, `${FIRST}: No key is set\nprovider_key_missing — openai — OPENAI_API_KEY — cheap`, "the error projection drifted");
			assert.equal(page.js("document.querySelector('[data-testid=import-notes]').disabled"), false, "the import control stayed disabled after settle");
			assert.equal(page.q('[data-testid="import-notes"]'), "Import notes…", "the settled label drifted");
			await page.waitForJs(
				`window.__apiProbe.calls.filter((call) => call.method === "GET" && call.pathname === "/api/graph").length === ${count(before, "/api/graph") + 1}`,
				8_000,
				"onFinished graph refresh",
			);
			assert.equal(count(apiCalls(page), "/api/graph/costs"), count(before, "/api/graph/costs") + 1, "onFinished did not refresh costs exactly once");

			// A new attempt clears the old alert immediately; the same File can reimport.
			reply(page, { results: [completed(FIRST)] });
			upload(page, INPUT, [firstFile]);
			await page.waitForJs("window.__notesImport.requests.length === 2 && window.__notesImport.requests[1].files.length === 1", 8_000, "second import POST");
			assert.equal(page.count(ALERT), 0, "the previous error survived the next attempt");
			assert.equal(page.q('[data-testid="import-notes"]'), "Importing…", "the reimport did not report pending");
			const second = page.js("window.__notesImport.requests[1]");
			assert.deepEqual(second.files, [{ name: FIRST, type: "text/markdown", text: FIRST_TEXT }], "the same-file reimport did not resend the file");
			reply(page, { results: [completed(FIRST)] });
			await page.waitForJs("document.querySelector('[data-testid=import-notes]').disabled === false", 8_000, "successful import settle");
			assert.equal(page.count(ALERT), 0, "a successful import left an error alert");
			assert.equal(page.q('[data-testid="import-notes"]'), "Import notes…", "the success label drifted");
			assert.equal(second.method, "POST", "the reimport did not POST");
			page.screenshot("notes-import-01-settled");
			return { first, second, alertText };
		} finally {
			page.close();
		}
	});

	await check("notes import: one real multi-file event sends both files and renders independent escaped alerts in selection order", async () => {
		const fixtureDir = path.join(run.runDir, "notes-multi");
		fs.mkdirSync(fixtureDir, { recursive: true });
		const alphaName = "alpha-notes.md";
		const betaName = "beta-notes.md";
		const alpha = path.join(fixtureDir, alphaName);
		const beta = path.join(fixtureDir, betaName);
		fs.writeFileSync(alpha, "alpha synthetic notes\n");
		fs.writeFileSync(beta, "beta synthetic notes\n");
		const page = browser(run, "notes-import-multi", { initScript: initScript(run, "notes-import-multi-boundary", notesImportScript()) });
		try {
			await page.goto("/", { ready: '[data-testid="import-notes"]' });
			upload(page, INPUT, [alpha, beta]);
			await page.waitForJs("window.__notesImport.requests.length === 1 && window.__notesImport.requests[0].files.length === 2", 8_000, "multi-file import POST");
			const captured = page.js("window.__notesImport.requests[0].files");
			assert.deepEqual(captured.map((file) => [file.name, file.text]), [[alphaName, "alpha synthetic notes\n"], [betaName, "beta synthetic notes\n"]], `the multi-file FormData drifted: ${JSON.stringify(captured)}`);
			reply(page, { results: [
				{ requestIndex: 1, filePath: betaName, ok: false, outcome: "failed", error: "beta failed" },
				{ requestIndex: 0, filePath: alphaName, ok: false, outcome: "failed", error: "<img src=x onerror=alert(1)> alpha failed" },
			] });
			await page.waitForJs(`document.querySelectorAll('[role=alert]').length === 2`, 8_000, "two import alerts");
			const alerts = page.js(`[...document.querySelectorAll('[role=alert]')].map((node) => ({ text: node.textContent, html: node.innerHTML }))`);
			assert.equal(alerts[0].text, `${alphaName}: <img src=x onerror=alert(1)> alpha failed`, "the first alert lost its raw failure text");
			assert.equal(alerts[1].text, `${betaName}: beta failed`, "the second alert lost its raw failure text");
			assert.ok(alerts[0].html.includes("&lt;img"), "the alert no longer HTML-escapes failure text");
			assert.equal(page.count('[role="alert"] img, [role="alert"] script'), 0, "failure text was injected as live DOM");
			page.screenshot("notes-import-02-multi-alert");
			return { files: captured.map((file) => file.name), alerts: alerts.map((alert) => alert.text) };
		} finally {
			page.close();
		}
	});
}
