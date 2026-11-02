/**
 * Electron update-banner renderer contract (old tests/render-update-banner.tsx,
 * Wave C): a labelled `window.lh` mock matching electron/preload.cjs is
 * injected before hydration, then the shell's push is driven only to
 * `downloaded`; every other status stays hidden. Restart invokes the bridge.
 *
 * This proves RENDERER bridge handling in a web page. It is not native
 * Electron IPC, not electron-updater, and not a signed release.
 */
import assert from "node:assert/strict";
import { browser, initScript, sleep } from "./frontend-harness.mjs";

const BANNER = '[data-testid="update-banner"]';

/** The preload surface (electron/preload.cjs) with a recorded push channel. */
export const BRIDGE_SCRIPT = `(() => {
	const state = { subscriptions: [], installs: 0, pushes: [], expandWindow: 0 };
	Object.defineProperty(window, "__lhBridge", { value: state, configurable: true });
	window.lh = {
		platform: "linux",
		expandWindow: () => { state.expandWindow += 1; },
		onZoom: () => () => {},
		getZoom: () => Promise.resolve(1),
		onUpdateStatus: (cb) => {
			const entry = { cb, active: true };
			state.subscriptions.push(entry);
			return () => {
				if (!entry.active) return;
				entry.active = false;
			};
		},
		installUpdate: () => { state.installs += 1; },
	};
	window.__lhPush = (status) => {
		state.pushes.push(status);
		for (const entry of state.subscriptions) if (entry.active) entry.cb(status);
	};
})();`;

const LABELS = {
	checking: { status: "checking", version: null },
	available: { status: "available", version: "9.9.9" },
	downloading: { status: "downloading", version: "9.9.9" },
	error: { status: "error", version: "9.9.9" },
	downloaded: { status: "downloaded", version: "9.9.9" },
};

export async function run(run, check) {
	await check("update banner: labelled window.lh push gates on downloaded, Restart calls installUpdate, one bridge subscription", async () => {
		const page = browser(run, "update-bridge", { initScript: initScript(run, "update-bridge", BRIDGE_SCRIPT) });
		try {
			await page.goto("/", { ready: "textarea" });
			assert.equal(page.js("typeof window.lh?.onUpdateStatus"), "function", "the pre-injected bridge is not visible to the app");
			await page.waitForJs("window.__lhBridge.subscriptions.length === 1", 8_000, "the banner subscribed to the bridge");
			const bridge = page.js(`({
				subs: window.__lhBridge.subscriptions.length,
				active: window.__lhBridge.subscriptions.filter((entry) => entry.active).length,
				unsubscribeType: typeof window.__lhBridge.subscriptions[0]?.cb,
				banner: !!document.querySelector(${JSON.stringify(BANNER)}),
			})`);
			assert.equal(bridge.subs, 1, `expected exactly one bridge subscription, saw ${bridge.subs}`);
			assert.equal(bridge.active, 1, "the first bridge subscription is not active");
			assert.equal(bridge.unsubscribeType, "function", "the bridge callback doesn't look like the preload listener");
			assert.equal(bridge.banner, false, "the banner rendered before any push");

			for (const key of ["checking", "available", "downloading", "error"]) {
				page.js(`window.__lhPush(${JSON.stringify(LABELS[key])})`);
				await sleep(150);
				assert.equal(page.exists(BANNER), false, `the ${key} push rendered a banner; the baseline gates on downloaded only`);
			}
			page.js(`window.__lhPush(${JSON.stringify(LABELS.downloaded)})`);
			await page.waitForJs(`!!document.querySelector(${JSON.stringify(BANNER)})`, 5_000, "banner after the downloaded push");
			const shown = page.js(`(() => {
				const banner = document.querySelector(${JSON.stringify(BANNER)});
				const button = banner.querySelector('button');
				return {
					text: banner.innerText,
					button: button?.innerText ?? null,
					installs: window.__lhBridge.installs,
					progress: banner.querySelectorAll('progress,[role=progressbar]').length,
					subs: window.__lhBridge.subscriptions.length,
				};
			})()`);
			assert.ok(shown.text.includes("LearnHarness 9.9.9 is ready"), `the banner lost the version line: ${JSON.stringify(shown.text)}`);
			assert.ok(shown.text.includes("restart to finish installing"), `the banner lost the restart copy: ${JSON.stringify(shown.text)}`);
			assert.equal(shown.button, "Restart", "the banner lost its Restart button");
			assert.equal(shown.progress, 0, "the baseline banner has no progress element");
			assert.equal(shown.installs, 0, "Restart fired before any click");
			assert.equal(shown.subs, 1, "the banner re-subscribed on render");

			page.click(`${BANNER} button`);
			await page.waitForJs("window.__lhBridge.installs === 1", 5_000, "Restart called installUpdate once");
			assert.equal(page.exists(BANNER), true, "Restart hid the banner (installs on quit)");

			page.js(`window.__lhPush(${JSON.stringify({ status: "downloaded", version: null })})`);
			await page.waitForJs(`document.querySelector(${JSON.stringify(BANNER)})?.innerText.includes('LearnHarness update is ready')`, 5_000, "null-version fallback");
			const fallback = await page.q(BANNER);
			assert.ok(fallback.includes("LearnHarness update is ready"), `the null-version banner copy drifted: ${JSON.stringify(fallback)}`);

			page.click(`${BANNER} button`);
			await page.waitForJs("window.__lhBridge.installs === 2", 5_000, "the second Restart click reached installUpdate");
			const afterClicks = page.js(`({ installs: window.__lhBridge.installs, subs: window.__lhBridge.subscriptions.length, pushes: window.__lhBridge.pushes.length })`);
			assert.equal(afterClicks.installs, 2, "the bridge install counter drifted");
			assert.equal(afterClicks.subs, 1, "a push created a second bridge subscription");

			page.clickText('[data-testid="session-row"]', "");
			await page.waitForJs(`location.pathname.startsWith('/chat/')`, 15_000, "SPA navigation to a chat");
			await sleep(500);
			const afterNav = page.js(`({ subs: window.__lhBridge.subscriptions.length, banner: !!document.querySelector(${JSON.stringify(BANNER)}) })`);
			assert.equal(afterNav.subs, 1, "SPA navigation re-subscribed the banner");
			assert.equal(afterNav.banner, true, "the banner disappeared on SPA navigation");
			page.screenshot("bridge-01-banner");
			return { shown, fallback: fallback.slice(0, 80), afterClicks, afterNav };
		} finally {
			page.close();
		}
	});

	await check("update banner: a browser build (no window.lh) never renders or subscribes", async () => {
		const page = browser(run, "update-bridge-none");
		try {
			await page.goto("/", { ready: "textarea" });
			await sleep(600);
			assert.equal(page.js("typeof window.lh"), "undefined", "a bridge exists without the init script");
			assert.equal(page.exists(BANNER), false, "the banner rendered without a bridge");
			page.screenshot("bridge-02-no-bridge");
			return { bridge: page.js("typeof window.lh"), banner: page.exists(BANNER) };
		} finally {
			page.close();
		}
	});
}
