import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO, browser, defaultRunDir, reporter, startRun } from "./frontend-harness.mjs";
import * as zeroKeys from "./frontend-suite-zero-keys.mjs";
import * as setup from "./frontend-suite-setup-dropdowns.mjs";
import * as research from "./frontend-suite-research-settings.mjs";
import * as modelPicker from "./frontend-suite-model-picker.mjs";
import * as toolContent from "./frontend-suite-tool-content.mjs";
import * as deferred from "./frontend-suite-deferred.mjs";
import * as notesImport from "./frontend-suite-notes-import.mjs";
import * as activity from "./frontend-suite-activity.mjs";
import * as coverage from "./frontend-suite-coverage.mjs";
import * as bridge from "./frontend-suite-bridge.mjs";

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
	const index = args.indexOf(name);
	return index >= 0 ? path.resolve(args[index + 1]) : fallback;
};

const runDir = argValue("--run-dir", defaultRunDir());
const startedAt = new Date().toISOString();

function seedChat(dataDir) {
	const file = path.join(dataDir, "chats", `${modelPicker.SEEDED_CHAT}.json`);
	assert.ok(fs.existsSync(file), `seeded chat fixture missing: ${file}`);
	const record = JSON.parse(fs.readFileSync(file, "utf8"));
	record.settings = { model: { provider: "custom-endpoint", id: modelPicker.RETIRED_MODEL }, thinkingLevel: "off" };
	fs.writeFileSync(file, `${JSON.stringify(record, null, "\t")}\n`);
}

async function setSlots(run) {
	const { res, body } = await run.jsonApi("/api/settings/models", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			strong: { model: { provider: "custom-endpoint", id: "mock-responses" }, thinkingLevel: "off" },
			cheap: { model: { provider: "custom-endpoint", id: "mock-responses" }, thinkingLevel: "off" },
			vision: { model: { provider: "custom-endpoint", id: "mock-responses" }, thinkingLevel: "off" },
		}),
	});
	assert.equal(res.status, 200, `model slots → ${res.status} ${JSON.stringify(body)}`);
}

const run = await startRun({
	label: "frontend-interactions",
	payload: argValue("--payload", path.join(REPO, "dist-server", "standalone")),
	data: argValue("--data", path.join(REPO, "tests", "fixtures", "golden-data")),
	runDir,
	prepareData: seedChat,
});
const { check, write } = reporter();
console.log(`[frontend] payload ${run.payload}\n[frontend] run ${run.runDir}\n[frontend] base ${run.base}`);
try {
	await check("harness: native clicks cannot bypass a covering element", async () => {
		const page = browser(run, "native-click-safety");
		try {
			page.js(`window.__testClicks = 0;
				const button = document.createElement("button");
				button.textContent = "Blocked action";
				button.style.cssText = "position:fixed;top:30px;left:30px";
				button.onclick = () => window.__testClicks++;
				document.body.append(button); true`);
			page.clickText("button", "Blocked action");
			assert.equal(page.js("window.__testClicks"), 1, "visible control receives a native click");
			page.js(`const cover = document.createElement("div");
				cover.style.cssText = "position:fixed;inset:0;z-index:2147483647";
				document.body.append(cover); true`);
			try { page.clickText("button", "Blocked action"); } catch {}
			assert.equal(page.js("window.__testClicks"), 1, "covered control is not activated by a JavaScript fallback");
		} finally { page.close(); }
	});
	await zeroKeys.run(run, check);
	await setup.run(run, check);
	await research.run(run, check);
	await modelPicker.configureScriptedProvider(run);
	await setSlots(run);
	await modelPicker.run(run, check);
	await activity.run(run, check);
	await toolContent.run(run, check);
	await deferred.run(run, check);
	await notesImport.run(run, check);
	await bridge.run(run, check);
	// Last: the minimal-home checks flip the shipped graph-rendering setting.
	await coverage.run(run, check);
	await check("harness: every provider request hit the loopback mock with the dummy key", async () => {
		assert.ok(run.mock.requests.length >= 1, "no provider request reached the scripted mock");
		for (const request of run.mock.requests) {
			assert.ok(["mathquiz", "fast", "explain", "research", "researchslow"].includes(request.mode), `unexpected provider mode ${request.mode}`);
			assert.ok(String(request.authorization).includes("lh-gap-dummy-custom-key-000000000001"), `provider request used a non-dummy credential: ${request.authorization}`);
		}
		return { requests: run.mock.requests.length, tags: [...new Set(run.mock.requests.map((request) => request.tag))] };
	});
} finally {
	const summary = write(run, { startedAt });
	await run.stop();
	console.log(`[frontend] ${summary.pass} passed, ${summary.fail} failed`);
	console.log(`[frontend] results ${path.join(run.runDir, "results.json")}`);
	process.exitCode = summary.fail > 0 ? 1 : 0;
}
