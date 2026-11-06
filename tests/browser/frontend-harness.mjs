import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "../../electron/free-port.cjs";
import { mockProvider } from "./frontend-mock-provider.mjs";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanEnv(home) {
	const kept = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
		!/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) &&
		!/^(AWS_|GOOGLE_|GCLOUD_|CLOUDSDK_|AZURE_|ANTHROPIC_|OPENAI_|OPENROUTER_|GEMINI_)/.test(key) &&
		!["NODE_OPTIONS", "NODE_PATH", "LH_ROOT", "LH_DEV_URL", "ELECTRON_RUN_AS_NODE", "LH_IGNORE_ENV_KEYS"].includes(key)));
	return {
		...kept,
		HOME: home,
		USERPROFILE: home,
		APPDATA: path.join(home, "config"),
		LOCALAPPDATA: path.join(home, "local"),
		XDG_CONFIG_HOME: path.join(home, "config"),
		XDG_CACHE_HOME: path.join(home, "cache"),
		LH_DATA_DIR: path.join(home, "data"),
		LH_AUTH_FILE: path.join(home, "auth.json"),
		LH_IGNORE_ENV_KEYS: "1",
		NODE_ENV: "production",
	};
}

function fileHash(file) {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function copyTree(from, to) {
	fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

export function defaultRunDir() {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return process.env.LH_GAP_RUN_DIR || path.join(os.tmpdir(), "learn-frontend-gap-tests", stamp);
}

export async function startRun({
	label = "frontend-interactions",
	payload = path.join(REPO, "dist-server", "standalone"),
	data = path.join(REPO, "tests", "fixtures", "golden-data"),
	runDir = defaultRunDir(),
	prepareData,
} = {}) {
	assert.ok(fs.existsSync(path.join(payload, "server.js")), `${payload}/server.js missing — build the payload first`);
	fs.mkdirSync(runDir, { recursive: true });
	const isolatedPayload = path.join(runDir, "payload");
	copyTree(payload, isolatedPayload);
	const home = path.join(runDir, "home");
	fs.mkdirSync(home, { recursive: true });
	fs.writeFileSync(path.join(home, "auth.json"), "{}\n", { mode: 0o600 });
	const dataDir = path.join(home, "data");
	copyTree(data, dataDir);
	prepareData?.(dataDir);

	const mock = mockProvider();
	const mockBase = await mock.listen();
	const port = await freePort();
	const logs = [];
	const child = spawn(process.execPath, [path.join(isolatedPayload, "server.js")], {
		cwd: isolatedPayload,
		env: { ...cleanEnv(home), PORT: String(port), HOSTNAME: "127.0.0.1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
	child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
	const base = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 40_000;
	let booted = false;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${base}/api/graph`, { signal: AbortSignal.timeout(2_000) });
			await res.text();
			if (res.status === 200) {
				booted = true;
				break;
			}
		} catch {}
		await sleep(200);
	}
	if (!booted) {
		child.kill("SIGKILL");
		await mock.close();
		throw new Error(`server never answered 200 on ${base}/api/graph\n${logs.join("")}`);
	}

	const run = {
		label,
		runDir,
		payload: isolatedPayload,
		payloadHash: { server: fileHash(path.join(isolatedPayload, "server.js")), handler: fileHash(path.join(isolatedPayload, "handler.js")) },
		home,
		dataDir,
		base,
		mock,
		mockBase,
		logs,
		async api(pathname, init = {}, timeoutMs = 15_000) {
			return fetch(base + pathname, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
		},
		async jsonApi(pathname, init) {
			const res = await run.api(pathname, init);
			const text = await res.text();
			let body;
			try {
				body = JSON.parse(text);
			} catch {
				body = text;
			}
			return { res, body };
		},
		async getChat(id) {
			const { res, body } = await run.jsonApi(`/api/chats/${id}`);
			assert.equal(res.status, 200, `GET /api/chats/${id} → ${res.status}`);
			return body;
		},
		async waitSettled(id, timeoutMs = 30_000) {
			const started = Date.now();
			while (Date.now() - started < timeoutMs) {
				const record = await run.getChat(id);
				if (record.turnInFlight !== true) return record;
				await sleep(150);
			}
			throw new Error(`timeout waiting for ${id} to settle`);
		},
		async stop() {
			await mock.close();
			if (child.exitCode === null) {
				await new Promise((resolve) => {
					const timer = setTimeout(() => {
						child.kill("SIGKILL");
						resolve();
					}, 5_000);
					child.once("exit", () => {
						clearTimeout(timer);
						resolve();
					});
					child.kill("SIGTERM");
				});
			}
			fs.writeFileSync(path.join(runDir, "server.log"), logs.join(""));
		},
	};
	return run;
}

/** One agent-browser session. Call close() in a finally block. */
export function browser(run, label, { initScript } = {}) {
	const session = `lh-gap-${label}-${process.pid}-${Date.now()}`;
	const ab = (args, { input, timeout = 60_000 } = {}) => {
		const result = spawnSync("agent-browser", ["--session", session, ...args], {
			encoding: "utf8",
			input,
			timeout,
			maxBuffer: 20 * 1024 * 1024,
			env: { ...process.env, AGENT_BROWSER_SESSION: session },
		});
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`agent-browser ${args.join(" ")} → ${result.status}\n${result.stdout}\n${result.stderr}`);
		return result.stdout.trim();
	};
	const page = {
		session,
		js(code) {
			const out = ab(["eval", "--stdin"], { input: code });
			if (!out) return undefined;
			try {
				return JSON.parse(out);
			} catch {
				return out;
			}
		},
		q(selector) {
			return page.js(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? null`);
		},
		exists(selector) {
			return page.js(`!!document.querySelector(${JSON.stringify(selector)})`);
		},
		count(selector) {
			return page.js(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
		},
		click(selector) {
			ab(["click", selector], { timeout: 20_000 });
		},
		clickText(selector, text) {
			const hit = page.js(`(() => {
				document.querySelectorAll("[data-browser-click-target]").forEach((node) => node.removeAttribute("data-browser-click-target"));
				const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.innerText.includes(${JSON.stringify(text)}));
				el?.setAttribute("data-browser-click-target", "");
				return !!el;
			})()`);
			assert.equal(hit, true, `click ${selector} containing ${JSON.stringify(text)}`);
			page.click("[data-browser-click-target]");
		},
		fill(selector, value) {
			ab(["fill", selector, value], { timeout: 20_000 });
		},
		press(key) {
			ab(["press", key], { timeout: 20_000 });
		},
		move(x, y) {
			ab(["mouse", "move", String(x), String(y)], { timeout: 20_000 });
		},
		down(button = "left") {
			ab(["mouse", "down", button], { timeout: 20_000 });
		},
		up(button = "left") {
			ab(["mouse", "up", button], { timeout: 20_000 });
		},
		async goto(pathname, { ready, timeout = 25_000 } = {}) {
			ab(["navigate", run.base + pathname], { timeout: 60_000 });
			await page.waitForJs(`location.pathname === ${JSON.stringify(new URL(run.base + pathname).pathname)}`, timeout, `navigation to ${pathname}`);
			if (ready) await page.waitForJs(`!!document.querySelector(${JSON.stringify(ready)})`, timeout, `ready: ${pathname}`);
			await sleep(500);
		},
		async reload({ ready, timeout = 25_000 } = {}) {
			ab(["reload"], { timeout: 60_000 });
			await page.waitForJs("document.readyState === 'complete'", timeout, "reload complete");
			if (ready) await page.waitForJs(`!!document.querySelector(${JSON.stringify(ready)})`, timeout, `ready after reload`);
			await sleep(500);
		},
		async waitForJs(expression, timeoutMs, what) {
			const started = Date.now();
			let last;
			while (Date.now() - started < timeoutMs) {
				try {
					last = page.js(expression);
					if (last) return last;
				} catch (error) {
					last = String(error);
				}
				await sleep(100);
			}
			throw new Error(`timeout waiting for ${what} (last=${JSON.stringify(last)})`);
		},
		screenshot(name) {
			const target = path.join(run.runDir, "shots", `${name}.png`);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			ab(["screenshot", target], { timeout: 30_000 });
			return target;
		},
		box(selector) {
			return page.js(`(() => {
				const el = document.querySelector(${JSON.stringify(selector)});
				if (!el) return null;
				const rect = el.getBoundingClientRect();
				return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom, right: rect.right };
			})()`);
		},
		close() {
			try {
				ab(["close"], { timeout: 20_000 });
			} catch {}
		},
	};
	ab(["open", ...(initScript ? ["--init-script", initScript] : []), "--json"]);
	ab(["set", "viewport", "1440", "900", "1", "--json"]);
	return page;
}

/** Write a page bootstrap script (runs before app code) and return its path. */
export function initScript(run, name, body) {
	const file = path.join(run.runDir, `${name}.init.js`);
	fs.writeFileSync(file, body);
	return file;
}

/** Observation-only bridge: records every fetch the page makes. */
export const API_PROBE_SCRIPT = `(() => {
	window.__apiProbe = { calls: [] };
	const original = window.fetch;
	window.fetch = function (input, init) {
		const raw = typeof input === "string" ? input : (input && input.url) || "";
		let pathname = raw;
		try { pathname = new URL(raw, location.href).pathname; } catch {}
		window.__apiProbe.calls.push({
			pathname,
			method: (init && init.method) || "GET",
			body: init && typeof init.body === "string" ? init.body : null,
		});
		return original.apply(this, arguments);
	};
	return true;
})();`;

export function installApiProbe(page) {
	page.js(API_PROBE_SCRIPT);
}

export function apiCalls(page) {
	return page.js("window.__apiProbe ? window.__apiProbe.calls : []") ?? [];
}

export function reporter() {
	const results = [];
	async function check(name, fn) {
		try {
			const detail = await fn();
			results.push({ name, status: "PASS", detail });
			console.log(`PASS ${name}`);
			return detail;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			results.push({ name, status: "FAIL", error: message });
			console.error(`FAIL ${name}: ${message}`);
			return undefined;
		}
	}
	function write(run, extra = {}) {
		fs.mkdirSync(run.runDir, { recursive: true });
		const summary = {
			startedAt: extra.startedAt,
			finishedAt: new Date().toISOString(),
			payload: run.payload,
			payloadHash: run.payloadHash,
			base: run.base,
			provider: "LOCAL SCRIPTED MOCK (127.0.0.1) — no external calls, not a model",
			results,
			pass: results.filter((r) => r.status === "PASS").length,
			fail: results.filter((r) => r.status === "FAIL").length,
		};
		fs.writeFileSync(path.join(run.runDir, "results.json"), JSON.stringify(summary, null, 2));
		return summary;
	}
	return { results, check, write };
}
