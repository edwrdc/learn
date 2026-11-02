#!/usr/bin/env node
/**
 * Optimistic first-send regression proof.
 *
 * Boots a disposable copy of a packaged payload against a copy of the golden
 * data and a loopback scripted OpenAI Responses endpoint, then drives the real
 * /chat/new -> /chat/<id>?prompt=... first send with a 1.2 s stall injected into
 * the page's first POST /api/chat.
 *
 * Fixed behavior asserts the learner bubble stays visible while the POST is
 * still pending, the streamed reply lands exactly once, and the settled record
 * holds one user and one assistant message. `--expect-regression` inverts the
 * mid-POST assertion so a pre-fix payload proves the erasure reproducibly.
 *
 * Usage:
 *   node tests/browser/optimistic-messages.mjs --payload <packaged-payload>
 *   node tests/browser/optimistic-messages.mjs --payload <pre-fix-payload> --expect-regression
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { browser, initScript, sleep, startRun } from "./frontend-harness.mjs";

function argValue(flag) {
	const index = process.argv.indexOf(flag);
	if (index < 0) return undefined;
	const value = process.argv[index + 1];
	return value && !value.startsWith("--") ? value : undefined;
}

const payloadArg = argValue("--payload");
if (!payloadArg) {
	console.error("usage: node tests/browser/optimistic-messages.mjs --payload <packaged-payload> [--expect-regression]");
	process.exit(2);
}
const payload = path.resolve(payloadArg);
const expectRegression = process.argv.includes("--expect-regression");
const DELAY_MS = 1200;
const TAG = `P${process.pid.toString(36)}${Date.now().toString(36)}`.toUpperCase();
const PROMPT = `Optimistic first send [[MOCK:fast:${TAG}]]`;
const SEGMENTS = [0, 1, 2].map((index) => `SEG_${TAG}_0${index + 1}`);
const MOCK_KEY = `lh-optimistic-${TAG.toLowerCase()}-dummy-key-not-real`;
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-optimistic-"));

/** Records the first optimistic bubble, client errors, and the stalled POST. */
function probeScript() {
	return `(() => {
	const probe = (window.__optimisticProbe = { userAt: null, userText: null, postCallAt: null, postSentAt: null, postEndedAt: null });
	window.__optimisticErrors = [];
	addEventListener("error", (event) => window.__optimisticErrors.push("error: " + (event.message || "unknown")));
	addEventListener("unhandledrejection", (event) => window.__optimisticErrors.push("rejection: " + String(event.reason)));
	const nativeConsoleError = console.error.bind(console);
	console.error = (...args) => {
		window.__optimisticErrors.push("console: " + args.map((value) => String(value)).join(" "));
		nativeConsoleError(...args);
	};
	new MutationObserver(() => {
		if (probe.userAt !== null) return;
		const node = document.querySelector('[data-testid="user-message"]');
		if (!node) return;
		probe.userAt = performance.now();
		probe.userText = node.innerText;
	}).observe(document, { childList: true, subtree: true });
	const nativeFetch = window.fetch;
	window.fetch = function (input, init) {
		const url = typeof input === "string" ? input : (input && input.url) || "";
		const pathname = new URL(url, location.href).pathname;
		if (pathname === "/api/chat" && probe.postCallAt === null) {
			probe.postCallAt = performance.now();
			const self = this;
			return new Promise((resolve) => {
				setTimeout(() => {
					probe.postSentAt = performance.now();
					const pending = nativeFetch.call(self, input, init);
					pending.then(() => (probe.postEndedAt = performance.now()), () => (probe.postEndedAt = performance.now()));
					resolve(pending);
				}, ${DELAY_MS});
			});
		}
		return nativeFetch.apply(this, arguments);
	};
})();`;
}

/** Firefox/Chrome report this benign layout warning through window.onerror. */
function appErrors(errors) {
	return errors.filter((entry) => !/^(?:error|console): ResizeObserver loop (completed with undelivered notifications|limit exceeded)\.?$/.test(entry));
}

function textOf(message) {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content.map((block) => (block && (block.type === "text" || block.type === "output_text") ? (block.text ?? "") : "")).join("");
	}
	return "";
}

function count(haystack, needle) {
	return haystack.split(needle).length - 1;
}

async function configureMock(run) {
	const endpoint = await run.jsonApi("/api/custom-endpoint", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			displayName: "LOOPBACK OPTIMISTIC MOCK",
			baseUrl: `${run.mockBase}/v1`,
			models: [{ id: "mock-responses", name: "mock-responses", contextWindow: 100000, maxTokens: 4096, reasoning: false, imageInput: true }],
			apiKey: MOCK_KEY,
		}),
	});
	assert.equal(endpoint.res.status, 200, "custom endpoint setup failed");
	const models = await run.jsonApi("/api/settings/models", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			strong: { model: { provider: "custom-endpoint", id: "mock-responses" }, thinkingLevel: "off" },
			cheap: { model: { provider: "custom-endpoint", id: "mock-responses" }, thinkingLevel: "off" },
			vision: { model: { provider: "custom-endpoint", id: "mock-responses" }, thinkingLevel: "off" },
		}),
	});
	assert.equal(models.res.status, 200, "model slots setup failed");
}

async function waitForAssistant(run, chatId) {
	const started = Date.now();
	let last;
	while (Date.now() - started < 30_000) {
		last = await run.getChat(chatId);
		const assistants = last.messages.filter((message) => message.role === "assistant");
		if (assistants.length === 1 && textOf(assistants[0]).includes(SEGMENTS[2])) return last;
		await sleep(200);
	}
	throw new Error(`record did not settle: ${JSON.stringify(last)?.slice(0, 800)}`);
}

async function main() {
	let failure;
	let result;
	const run = await startRun({ label: "optimistic-messages", payload, runDir: RUN_DIR });
	const page = browser(run, "optimistic", { initScript: initScript(run, "optimistic", probeScript()) });
	try {
		await configureMock(run);
		await page.goto("/chat/new", { ready: '[data-testid="composer"] textarea' });
		await sleep(1_800);
		const ready = page.js(
			`({ setup: !!document.querySelector('[data-testid=setup-dialog]'), cta: !!document.querySelector('[data-testid=setup-cta-keys]') })`,
		);
		assert.equal(ready.setup, false, "setup dialog opened before the first send");
		assert.equal(ready.cta, false, "zero-key CTA shown before the first send");

		page.fill('[data-testid="composer"] textarea', PROMPT);
		page.press("Enter");
		await page.waitForJs(
			"location.pathname.startsWith('/chat/') && location.pathname !== '/chat/new'",
			10_000,
			"chat route",
		);
		const chatId = page.js("location.pathname.split('/').pop()");
		await sleep(400);
		const mid = page.js(
			`({ users: document.querySelectorAll('[data-testid=user-message]').length,
				prompts: [...document.querySelectorAll('[data-testid=user-message]')].map((node) => node.innerText),
				log: document.querySelector('[role=log]')?.innerText ?? '',
				probe: window.__optimisticProbe,
				errors: window.__optimisticErrors,
				url: location.pathname })`,
		);
		const midHasPrompt = mid.prompts.some((text) => text.includes(PROMPT));
		console.log(
			`[optimistic] mid-POST users=${mid.users} prompt=${midHasPrompt} postSentAt=${mid.probe.postSentAt} log=${JSON.stringify(mid.log.slice(-60))}`,
		);
		if (expectRegression) {
			assert.equal(mid.users, 0, "pre-fix payload unexpectedly kept the optimistic bubble");
			assert.equal(midHasPrompt, false, "pre-fix payload unexpectedly kept the prompt text");
		} else {
			assert.equal(mid.users, 1, "fixed payload erased the optimistic bubble");
			assert.equal(midHasPrompt, true, "fixed payload lost the prompt text");
		}
		assert.equal(mid.probe.postSentAt, null, "the POST was already sent, so the proof missed the optimistic window");

		await page.waitForJs(`document.body.innerText.includes(${JSON.stringify(SEGMENTS[2])})`, 30_000, "streamed reply");
		const record = await waitForAssistant(run, chatId);
		await sleep(600);
		const final = page.js(
			`({ users: document.querySelectorAll('[data-testid=user-message]').length,
				prompts: [...document.querySelectorAll('[data-testid=user-message]')].map((node) => node.innerText),
				log: document.querySelector('[role=log]')?.innerText ?? '',
				probe: window.__optimisticProbe,
				errors: window.__optimisticErrors,
				url: location.pathname })`,
		);
		const users = record.messages.filter((message) => message.role === "user");
		const assistants = record.messages.filter((message) => message.role === "assistant");
		assert.equal(final.users, 1, "settled DOM lost the learner bubble");
		assert.equal(final.prompts.some((text) => text.includes(PROMPT)), true, "settled DOM lost the prompt text");
		for (const segment of SEGMENTS) {
			assert.equal(count(final.log, segment), 1, `settled DOM rendered ${segment} more than once`);
			assert.equal(count(JSON.stringify(record.messages), segment), 1, `record rendered ${segment} more than once`);
		}
		assert.equal(count(final.log, PROMPT), 1, "settled DOM rendered the prompt more than once");
		assert.equal(count(JSON.stringify(record.messages), PROMPT), 1, "record persisted the prompt more than once");
		assert.equal(users.length, 1, "record persisted more than one learner message");
		assert.equal(assistants.length, 1, "record persisted more than one assistant message");
		assert.equal(textOf(users[0]), PROMPT, "record's learner message differs from the prompt");
		assert.equal(run.mock.requests.length, 1, "the first prompt produced more than one provider request");
		assert.ok(run.mock.requests[0].authorization.includes(MOCK_KEY), "mock request lost the synthetic endpoint key");
		assert.equal(run.mock.requests[0].completed, true, "mock provider response did not complete");
		assert.deepEqual(appErrors(final.errors), [], "browser reported client errors");
		assert.notEqual(final.probe.postEndedAt, null, "the delayed POST never completed");
		result = {
			mode: expectRegression ? "negative-prefix" : "fixed",
			prompt: PROMPT,
			payload: run.payloadHash,
			runDir: run.runDir,
			chatId,
			midPost: { users: mid.users, hasPrompt: midHasPrompt, postSentAt: mid.probe.postSentAt, log: mid.log },
			settled: {
				users: final.users,
				hasPrompt: final.prompts.some((text) => text.includes(PROMPT)),
				segments: SEGMENTS,
				providerRequests: run.mock.requests.length,
				recordMessages: record.messages.map((message) => message.role),
				errors: appErrors(final.errors),
			},
		};
		if (expectRegression) {
			console.log("[optimistic] NEGATIVE PASS: the pre-fix payload erased the bubble while the POST was still pending");
		} else {
			console.log("[optimistic] PASS: the optimistic bubble stayed through the delayed POST and settled exactly once");
		}
		console.log(JSON.stringify(result));
	} catch (err) {
		failure = err;
	} finally {
		page.close();
		await run.stop();
		if (failure) {
			console.error(`[optimistic] FAILED, disposable tree kept at ${RUN_DIR}`);
			throw failure;
		}
		fs.rmSync(RUN_DIR, { recursive: true, force: true });
	}
}

await main();
