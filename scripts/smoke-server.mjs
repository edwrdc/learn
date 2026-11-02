/**
 * smoke-server.mjs — boot the packaged standalone server and prove it serves.
 *
 * The payload gate that pays for itself (2026-10-08): a successful build
 * and a completed electron-builder run say NOTHING about whether the
 * packaged server actually starts. On its first day this smoke caught two
 * real defects nothing else saw: (1) a trace-exclude regression that
 * stripped the pi engine packages to bare package.jsons — the server
 * answered 500 on every route with ERR_MODULE_NOT_FOUND; (2) before that,
 * the dev auth.json (BYOK keys) shipping inside the bundle. It runs
 * between build-server.mjs and electron-builder so a broken payload fails
 * in seconds, not after a full packaging pass.
 *
 * The payload is copied to os.tmpdir() BEFORE anything runs: booted inside the
 * checkout, Node resolves a package missing from the payload out of the
 * checkout's own node_modules, and the gate passes a payload that cannot run in
 * the app. The copy is then probed the way electron/main.cjs runs it: GET /
 * until 200, the GET-only API surface, and one chat created and read back so
 * the packaged durable store opens its SQLite file. --electron uses Electron's
 * bundled Node, otherwise the host Node; the child gets a kernel-assigned
 * 127.0.0.1 port, NODE_ENV=production and a THROWAWAY LH_DATA_DIR/LH_AUTH_FILE
 * under os.tmpdir(), so no real key or data is touched. No model call is made.
 * Any non-200, a missing database, an early exit or a 30s boot timeout fails
 * the gate and prints the server's log tail. The child is ALWAYS killed and the
 * copy deleted before exit.
 */
import { spawn } from "node:child_process";
import { probeEnv, verifyDemoRuntime } from "./smoke-demo-runtime.mjs";
import { verifyProviderRuntime } from "./smoke-provider-runtime.mjs";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "dist-server", "standalone");
const SERVER_FILE = "server.js";
const ELECTRON_MODE = process.argv.includes("--electron");
const RUNTIME = ELECTRON_MODE ? createRequire(import.meta.url)("electron") : process.execPath;

const POLL_MS = 500;
const BOOT_TIMEOUT_MS = 30_000;
/** GET-only probes — the routes that exercised today's failure class. */
const PROBES = ["/api/graph", "/api/models", "/api/settings"];

if (!fs.existsSync(path.join(SOURCE, SERVER_FILE))) {
	console.error("[smoke-server] dist-server/standalone/server.js missing — run npm run build && node scripts/build-server.mjs first.");
	process.exit(1);
}

/** A payload copy outside the worktree: in place, a missing package resolves from ROOT/node_modules. */
function isolatedPayload() {
	const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "lh-smoke-payload-"));
	for (let dir = path.dirname(isolated); ; dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, "node_modules"))) {
			fs.rmSync(isolated, { recursive: true, force: true });
			throw new Error(`the isolated payload would resolve packages from ${dir}/node_modules`);
		}
		if (path.dirname(dir) === dir) break;
	}
	fs.cpSync(SOURCE, isolated, { recursive: true });
	return isolated;
}

/** A free TCP port (listen(0) → the kernel assigns one) — mirrors main.cjs. */
function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

/** One JSON request; resolves { status, body } (0 = connection refused/failed). */
function request(url, method = "GET", payload) {
	return new Promise((resolve) => {
		const body = payload === undefined ? undefined : JSON.stringify(payload);
		const req = http.request(
			url,
			{
				method,
				headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {},
			},
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => (text += chunk));
				res.on("end", () => {
					let parsed;
					try {
						parsed = JSON.parse(text);
					} catch {
						parsed = text;
					}
					resolve({ status: res.statusCode ?? 0, body: parsed });
				});
			},
		);
		req.on("error", () => resolve({ status: 0, body: null }));
		req.setTimeout(5000, () => {
			req.destroy();
			resolve({ status: 0, body: null });
		});
		if (body) req.write(body);
		req.end();
	});
}

/** One GET; resolves the status code (0 = connection refused/failed). */
function get(url) {
	return new Promise((resolve) => {
		const req = http.get(url, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", () => resolve(0));
		req.setTimeout(5000, () => {
			req.destroy();
			resolve(0);
		});
	});
}

async function main() {
	const standalone = isolatedPayload();
	const server = path.join(standalone, SERVER_FILE);
	try {
		verifyDemoRuntime(standalone, RUNTIME);
		verifyProviderRuntime(standalone, RUNTIME);
	} catch (error) {
		fs.rmSync(standalone, { recursive: true, force: true });
		throw error;
	}
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-smoke-"));
	const dataDir = path.join(home, "data");
	const authFile = path.join(home, "auth.json");
	fs.writeFileSync(authFile, "{}\n", "utf-8");

	const tail = []; // rolling log tail for failure diagnosis
	let tailBytes = 0;
	const keep = (buf) => {
		for (const line of buf.toString().split("\n")) {
			tail.push(line);
			tailBytes += line.length + 1;
		}
		while (tailBytes > 16_000 && tail.length > 2) {
			tailBytes -= tail[0].length + 1;
			tail.shift();
		}
	};
	const dumpTail = () => {
		console.error("--- server log tail " + "-".repeat(20));
		for (const line of tail.slice(-40)) if (line.trim()) console.error(`    ${line}`);
	};

	console.log(`[smoke-server] payload: ${standalone} (outside the worktree; no ancestor node_modules)`);
	console.log(`[smoke-server] runtime: ${ELECTRON_MODE ? "Electron bundled Node" : "host Node"}`);
	const child = spawn(RUNTIME, [server], {
		cwd: standalone,
		env: {
			...probeEnv(process.env, home),
			...(ELECTRON_MODE ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
			NODE_ENV: "production",
			PORT: String(port),
			HOSTNAME: "127.0.0.1",
			LH_DATA_DIR: dataDir,
			LH_AUTH_FILE: authFile,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let exited = false;
	child.stdout.on("data", keep);
	child.stderr.on("data", keep);
	child.on("exit", () => {
		exited = true;
	});

	const kill = () =>
		new Promise((resolve) => {
			if (exited) return resolve();
			const done = () => resolve();
			child.once("exit", done);
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!exited) {
					try {
						child.kill("SIGKILL");
					} catch {
						/* already gone */
					}
				}
				done();
			}, 3000);
		});

	let failed = null;
	try {
		// Boot: poll GET / until 200 (or timeout / early exit).
		let boot = 0;
		const deadline = Date.now() + BOOT_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (exited) throw new Error(`server exited before answering on ${url}`);
			boot = await get(url);
			if (boot === 200) break;
			await new Promise((r) => setTimeout(r, POLL_MS));
		}
		if (boot !== 200) throw new Error(`server never answered 200 on ${url} (last status: ${boot})`);
		console.log(`[smoke-server] boot ok: GET / → 200 (${url})`);

		// API surface: every probe must be 200.
		for (const route of PROBES) {
			const status = await get(url + route);
			if (status !== 200) throw new Error(`GET ${route} → ${status} (expected 200)`);
			console.log(`[smoke-server] GET ${route} → 200`);
		}

		// The durable store: create one throwaway chat and read it back.
		// The read opens the packaged runtime and its SQLite file; no model call.
		const created = await request(url + "/api/chats", "POST", { title: "smoke: packaged durable store" });
		if (created.status !== 200 || typeof created.body?.id !== "string") {
			throw new Error(`POST /api/chats → ${created.status} (expected 200 with an id)`);
		}
		const chatId = created.body.id;
		const read = await request(`${url}/api/chats/${encodeURIComponent(chatId)}`);
		if (read.status !== 200 || read.body?.id !== chatId || !Array.isArray(read.body?.messages)) {
			throw new Error(`GET /api/chats/${chatId} → ${read.status} (the durable record did not round-trip)`);
		}
		const database = path.join(dataDir, "durable", chatId, "harness.sqlite");
		if (!fs.existsSync(database)) throw new Error("the packaged durable store did not open a SQLite file");
		if (!fs.readFileSync(database).subarray(0, 16).toString("latin1").startsWith("SQLite format 3")) {
			throw new Error("the packaged durable store file is not SQLite");
		}
		const list = await request(url + "/api/chats");
		if (list.status !== 200 || !Array.isArray(list.body?.chats) || !list.body.chats.some((chat) => chat.id === chatId)) {
			throw new Error(`GET /api/chats → ${list.status} (the created chat is not listed)`);
		}
		console.log(`[smoke-server] durable store: chat ${chatId} created, read back, SQLite opened`);
	} catch (err) {
		failed = err;
	} finally {
		await kill();
		for (const dir of [home, standalone]) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best effort — it's under os.tmpdir() */
			}
		}
	}

	if (failed) {
		console.error(`[smoke-server] FAIL: ${failed.message}`);
		dumpTail();
		process.exit(1);
	}
	console.log("[smoke-server] smoke passed — the packaged server boots and serves.");
}

main().catch((err) => {
	console.error(`[smoke-server] FAIL: ${err.message}`);
	process.exit(1);
});
