/**
 * Compaction status across a dropped events frame and across a held read.
 *
 * The send gate follows `compaction-changed`, so a frame missed between
 * emission and reconnect leaves it stale until a resync. The mock's slow mode
 * holds the compaction open so the suite can fire that resync mid-run.
 *
 * The second case parks resync status reads on both sides of the transition:
 * a stopped read held across the true event, and a running read held across
 * the false event. Releasing either older body must leave the newer event in
 * control, and the live transcript must survive the stale response.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { browser, initScript, sleep } from "./frontend-harness.mjs";

export const COMPACTION_CHAT = "chat_compaction_resync";
const TAG = "COMPACTRESYNC";
const PROMPT = `Compaction resync probe [[MOCK:fast:${TAG}]]`;

export const RACE_CHAT = "chat_compaction_race";
const RACE_TAG = "COMPACTRACE";
const RACE_PROMPT = `Compaction race probe [[MOCK:researchslow:${RACE_TAG}]]`;
const GATE_TEXT = "COMPACTING CONTEXT";

/** Over-threshold record: the cut summarizes the learner's slow-mode marker
 *  plus the graph-context backstory, leaving the filler as the kept tail. */
function writeCompactionRecord(dataDir, id, title, tag) {
	const chats = path.join(dataDir, "chats");
	fs.mkdirSync(chats, { recursive: true });
	const now = Date.now();
	const backstory = `Backstory paragraph for the ${title.toLowerCase()}.\n`.repeat(1_800);
	const filler = `Kept-tail filler paragraph for the ${title.toLowerCase()}.\n`.repeat(1_500);
	const record = {
		id,
		title,
		createdAt: new Date(now).toISOString(),
		updatedAt: new Date(now).toISOString(),
		settings: { model: { provider: "custom-endpoint", id: "mock-responses" }, thinkingLevel: "off" },
		messages: [
			{
				id: `msg_${id}_1`,
				role: "user",
				content: `Earlier lesson. [[MOCK:researchslow:${tag}]]`,
				timestamp: now,
			},
			{
				id: `msg_${id}_2`,
				role: "custom",
				customType: "graph-context",
				content: backstory,
				display: false,
				details: { picks: [], chains: [] },
				timestamp: now + 1,
			},
			{
				id: `msg_${id}_3`,
				role: "assistant",
				content: [{ type: "text", text: "Understood." }],
				timestamp: now + 2,
			},
			{ id: `msg_${id}_4`, role: "user", content: "Continue when ready.", timestamp: now + 3 },
			{
				id: `msg_${id}_5`,
				role: "assistant",
				content: [{ type: "text", text: "Ready." }],
				timestamp: now + 4,
			},
			{
				id: `msg_${id}_6`,
				role: "custom",
				customType: "graph-context",
				content: filler,
				display: false,
				details: { picks: [], chains: [] },
				timestamp: now + 5,
			},
		],
	};
	fs.writeFileSync(path.join(chats, `${id}.json`), `${JSON.stringify(record, null, "\t")}\n`);
}

export function seedCompactionChat(dataDir) {
	writeCompactionRecord(dataDir, COMPACTION_CHAT, "Compaction resync probe", TAG);
	writeCompactionRecord(dataDir, RACE_CHAT, "Compaction race probe", RACE_TAG);
}

/** Park the next chat-record read with its body already captured, so a newer
 *  event can land before the stale body is released back to the component.
 *  Holds queue by index: the race check starts the running read only after
 *  the stale idle read has been released. */
export function raceGateScript() {
	const chatPath = JSON.stringify(`/api/chats/${RACE_CHAT}`);
	return `(() => {
	const Native = window.EventSource;
	const control = (window.__lhCompactionHold = { armed: false, holds: [] });
	control.arm = () => { control.armed = true; };
	control.release = (index) => control.holds[index]?.release?.();
	const nativeFetch = window.fetch.bind(window);
	window.fetch = function (input, init) {
		const raw = typeof input === "string" ? input : (input && input.url) || "";
		let pathname = raw;
		try { pathname = new URL(raw, location.href).pathname; } catch {}
		const method = (init && init.method) || (input && input.method) || "GET";
		if (!control.armed || method !== "GET" || pathname !== ${chatPath}) {
			return nativeFetch(input, init);
		}
		control.armed = false;
		const hold = { bodyReady: false, released: false, body: null, release: null };
		control.holds.push(hold);
		return nativeFetch(input, init).then(async (res) => {
			const body = await res.text();
			hold.body = body;
			hold.bodyReady = true;
			await new Promise((resolve) => {
				hold.release = () => { hold.released = true; resolve(); };
			});
			return new Response(body, { status: res.status, headers: { "content-type": "application/json" } });
		});
	};
	window.EventSource = class extends Native {
		constructor(...args) {
			super(...args);
			control.source = this;
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

/** Drop every `compaction-changed` frame and capture the hub's onopen so the
 *  test can fire the reconnect resync at the exact moment it chooses. */
export function resyncGateScript() {
	return `(() => {
	const Native = window.EventSource;
	const control = (window.__lhCompactionGate = {});
	window.EventSource = class extends Native {
		constructor(...args) {
			super(...args);
			control.source = this;
			const add = this.addEventListener.bind(this);
			this.addEventListener = (type, listener, options) => {
				if (type === "compaction-changed") return;
				return add(type, listener, options);
			};
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

async function waitForRecord(run, chatId, predicate, timeoutMs, what) {
	const started = Date.now();
	let last;
	while (Date.now() - started < timeoutMs) {
		last = await run.getChat(chatId);
		const hit = predicate(last);
		if (hit) return hit;
		await sleep(120);
	}
	throw new Error(`timeout waiting for ${what} (last=${JSON.stringify(last)?.slice(0, 500)})`);
}

function textOf(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block?.type === "text" ? (block.text ?? "") : "")).join("");
}

export async function run(run, check) {
	await check("compaction status: reconnect resync repairs a missed compaction-changed event without replacing the transcript", async () => {
		const page = browser(run, "compaction-resync", {
			initScript: initScript(run, "compaction-resync", resyncGateScript()),
		});
		try {
			const settings = await run.jsonApi("/api/settings/compaction", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ thresholdTokens: 32_000 }),
			});
			assert.equal(settings.res.status, 200, `compaction threshold write → ${settings.res.status} ${JSON.stringify(settings.body)}`);

			await page.goto(`/chat/${COMPACTION_CHAT}`, { ready: '[data-testid="composer"] [data-testid="prose-field"]' });
			await page.waitForJs("!!window.__lhCompactionGate?.source", 10_000, "events channel created");
			const before = await run.getChat(COMPACTION_CHAT);
			assert.equal(before.compacting, false, "the seeded session started compacting");

			page.fill('[data-testid="composer"] [data-testid="prose-field"]', PROMPT);
			page.press("Enter");
			await waitForRecord(run, COMPACTION_CHAT, (record) => record.compacting === true, 15_000, "the server's compaction run");
			const slowStarted = Date.now();
			while (!run.mock.requests.some((request) => request.mode === "researchslow") && Date.now() - slowStarted < 10_000) await sleep(100);
			assert.ok(
				run.mock.requests.some((request) => request.mode === "researchslow"),
				`the compaction summary request did not reach the slow scripted provider (saw ${JSON.stringify(run.mock.requests.map((request) => request.mode))})`,
			);
			const gateText = "COMPACTING CONTEXT";
			assert.equal(
				page.js(`document.body.innerText.includes(${JSON.stringify(gateText)})`),
				false,
				"the page received the compaction frame, so the missed-event window was not reproduced",
			);
			assert.equal(
				page.js(`[...document.querySelectorAll('[data-testid=user-message]')].some((node) => node.innerText.includes("Compaction resync probe"))`),
				true,
				"the optimistic prompt vanished before the resync",
			);

			page.js("window.__lhCompactionGate.fireResync()");
			await page.waitForJs(`document.body.innerText.includes(${JSON.stringify(gateText)})`, 8_000, "compaction gate after the resync");
			assert.equal(
				page.js(`[...document.querySelectorAll('[data-testid=user-message]')].some((node) => node.innerText.includes("Compaction resync probe"))`),
				true,
				"the resync replaced the optimistic transcript",
			);

			await waitForRecord(run, COMPACTION_CHAT, (record) => record.compacting === false, 25_000, "the compaction run to finish");
			page.js("window.__lhCompactionGate.fireResync()");
			await page.waitForJs(`!document.body.innerText.includes(${JSON.stringify(gateText)})`, 8_000, "compaction gate cleared after the resync");

			const settled = await waitForRecord(
				run,
				COMPACTION_CHAT,
				(record) => {
					const marker = record.messages.find((message) => message.role === "custom" && message.customType === "compaction");
					return marker && textOf(record.messages.at(-1)).includes(`SEG_${TAG}_03`) ? record : null;
				},
				25_000,
				"the compacted turn to settle",
			);
			const marker = settled.messages.find((message) => message.role === "custom" && message.customType === "compaction");
			assert.ok(marker, "the record gained no compaction marker");
			assert.ok(textOf(settled.messages.at(-1)).includes(`SEG_${TAG}_03`), "the turn after compaction did not finish");
		} finally {
			page.close();
		}
	});

	await check("compaction status: a held status read cannot override a newer compaction-changed event in either direction or erase live output", async () => {
		const page = browser(run, "compaction-race", {
			initScript: initScript(run, "compaction-race", raceGateScript()),
		});
		try {
			const settings = await run.jsonApi("/api/settings/compaction", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ thresholdTokens: 32_000 }),
			});
			assert.equal(settings.res.status, 200, `compaction threshold write → ${settings.res.status} ${JSON.stringify(settings.body)}`);

			await page.goto(`/chat/${RACE_CHAT}`, { ready: '[data-testid="composer"] [data-testid="prose-field"]' });
			await page.waitForJs("!!window.__lhCompactionHold", 10_000, "the held-read hook");

			// Stale false: hold the idle status read, then let the send's true event land first.
			page.js("window.__lhCompactionHold.arm(); window.__lhCompactionHold.fireResync(); true");
			await page.waitForJs("window.__lhCompactionHold.holds[0]?.bodyReady", 10_000, "the held idle status body");
			assert.equal(page.js("JSON.parse(window.__lhCompactionHold.holds[0].body).compacting"), false, "the idle read did not capture the stopped state");
			assert.equal(page.js("window.__lhCompactionHold.holds[0].released"), false, "the idle read resolved before the newer event");

			page.fill('[data-testid="composer"] [data-testid="prose-field"]', RACE_PROMPT);
			page.press("Enter");
			await waitForRecord(run, RACE_CHAT, (record) => record.compacting === true, 15_000, "the race compaction run");
			await page.waitForJs(`document.body.innerText.includes(${JSON.stringify(GATE_TEXT)})`, 10_000, "the real compaction gate");
			const slowStarted = Date.now();
			while (
				!run.mock.requests.some((request) => request.mode === "researchslow" && request.tag === RACE_TAG) &&
				Date.now() - slowStarted < 10_000
			) {
				await sleep(100);
			}
			assert.ok(
				run.mock.requests.some((request) => request.mode === "researchslow" && request.tag === RACE_TAG),
				`the race summary request did not reach the slow scripted provider (saw ${JSON.stringify(run.mock.requests.map((request) => `${request.mode}:${request.tag}`))})`,
			);
			assert.equal(
				page.js(`[...document.querySelectorAll('[data-testid=user-message]')].some((node) => node.innerText.includes("Compaction race probe"))`),
				true,
				"the optimistic prompt vanished before the held read",
			);

			// Stale false: release the held idle read before any newer read starts, so only
			// the true event can keep it out.
			page.js("window.__lhCompactionHold.release(0); true");
			await page.waitForJs("window.__lhCompactionHold.holds[0].released", 5_000, "the stale idle read release");
			await sleep(700);
			assert.equal(
				page.js(`document.body.innerText.includes(${JSON.stringify(GATE_TEXT)})`),
				true,
				"the stale idle read cleared the gate over the newer event",
			);
			assert.equal(
				page.js(`[...document.querySelectorAll('[data-testid=user-message]')].some((node) => node.innerText.includes("Compaction race probe"))`),
				true,
				"the stale idle read erased the optimistic prompt",
			);

			// Stale true: hold a running status read at the newest revision, before the finished event lands.
			page.js("window.__lhCompactionHold.arm(); window.__lhCompactionHold.fireResync(); true");
			await page.waitForJs("window.__lhCompactionHold.holds[1]?.bodyReady", 10_000, "the held running status body");
			assert.equal(page.js("JSON.parse(window.__lhCompactionHold.holds[1].body).compacting"), true, "the running read did not capture the running state");
			assert.equal(page.js("window.__lhCompactionHold.holds[1].released"), false, "the running read resolved before the newer event");

			await page.waitForJs(`!document.body.innerText.includes(${JSON.stringify(GATE_TEXT)})`, 30_000, "the newer compaction-changed event clearing the gate");
			const afterCompaction = await run.getChat(RACE_CHAT);
			assert.equal(afterCompaction.compacting, false, "the server still reports compaction running");
			assert.equal(page.js("window.__lhCompactionHold.holds[1].released"), false, "the held read resolved before the release");

			const live = `RESEARCH_${RACE_TAG}_01`;
			await page.waitForJs(`document.body.innerText.includes(${JSON.stringify(live)})`, 20_000, "the live assistant stream");
			page.js("window.__lhCompactionHold.release(1); true");
			await page.waitForJs("window.__lhCompactionHold.holds[1].released", 5_000, "the held read release");
			await sleep(700);

			assert.equal(
				page.js(`document.body.innerText.includes(${JSON.stringify(GATE_TEXT)})`),
				false,
				"the stale read restored the compaction gate over the newer event",
			);
			assert.equal(
				page.js(`document.body.innerText.includes(${JSON.stringify(live)})`),
				true,
				"the stale read erased the live assistant stream",
			);
			assert.equal(
				page.js(`[...document.querySelectorAll('[data-testid=user-message]')].some((node) => node.innerText.includes("Compaction race probe"))`),
				true,
				"the stale read erased the optimistic prompt",
			);

			await run.waitSettled(RACE_CHAT, 30_000);
		} finally {
			page.close();
		}
	});
}
