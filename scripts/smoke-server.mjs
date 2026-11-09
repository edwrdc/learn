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
import { verifyDemoRuntime } from "./smoke-demo-runtime.mjs";
import { verifyProviderRuntime } from "./smoke-provider-runtime.mjs";
import * as fs from "node:fs";
import * as path from "node:path";
import { getStatus, isolatedPayload, postJson, request, smokeOptions, startPayloadServer } from "./smoke-harness.mjs";

const { source, electron, runtime } = smokeOptions("smoke-server");
/** GET-only probes — the routes that exercised today's failure class. */
const PROBES = ["/api/graph", "/api/models", "/api/settings"];

async function main() {
	const standalone = isolatedPayload(source, "lh-smoke-payload-");
	try {
		verifyDemoRuntime(standalone, runtime);
		verifyProviderRuntime(standalone, runtime);
	} catch (error) {
		fs.rmSync(standalone, { recursive: true, force: true });
		throw error;
	}
	console.log(`[smoke-server] payload: ${standalone} (outside the worktree; no ancestor node_modules)`);
	console.log(`[smoke-server] runtime: ${electron ? "Electron bundled Node" : "host Node"}`);
	const server = await startPayloadServer({ standalone, runtime, electron });
	const { url, dataDir } = server;
	console.log(`[smoke-server] boot ok: GET / → 200 (${url})`);

	let failed = null;
	try {
		for (const route of PROBES) {
			const status = await getStatus(url + route);
			if (status !== 200) throw new Error(`GET ${route} → ${status} (expected 200)`);
			console.log(`[smoke-server] GET ${route} → 200`);
		}

		// The durable store: create one throwaway chat and read it back.
		// The read opens the packaged runtime and its SQLite file; no model call.
		const created = await postJson(url + "/api/chats", { title: "smoke: packaged durable store" });
		const createdBody = await created.json().catch(() => null);
		if (created.status !== 200 || typeof createdBody?.id !== "string") {
			throw new Error(`POST /api/chats → ${created.status} (expected 200 with an id)`);
		}
		const chatId = createdBody.id;
		const read = await request(`${url}/api/chats/${encodeURIComponent(chatId)}`);
		const readBody = await read.json().catch(() => null);
		if (read.status !== 200 || readBody?.id !== chatId || !Array.isArray(readBody?.messages)) {
			throw new Error(`GET /api/chats/${chatId} → ${read.status} (the durable record did not round-trip)`);
		}
		const database = path.join(dataDir, "durable", chatId, "harness.sqlite");
		if (!fs.existsSync(database)) throw new Error("the packaged durable store did not open a SQLite file");
		if (!fs.readFileSync(database).subarray(0, 16).toString("latin1").startsWith("SQLite format 3")) {
			throw new Error("the packaged durable store file is not SQLite");
		}
		const list = await request(url + "/api/chats");
		const listBody = await list.json().catch(() => null);
		if (list.status !== 200 || !Array.isArray(listBody?.chats) || !listBody.chats.some((chat) => chat.id === chatId)) {
			throw new Error(`GET /api/chats → ${list.status} (the created chat is not listed)`);
		}
		console.log(`[smoke-server] durable store: chat ${chatId} created, read back, SQLite opened`);
	} catch (err) {
		failed = err;
	}
	const tail = server.logTail();
	await server.stop();
	if (failed) {
		console.error(`[smoke-server] FAIL: ${failed.message}`);
		console.error("--- server log tail " + "-".repeat(20));
		for (const line of tail) console.error(`    ${line}`);
		process.exit(1);
	}
	console.log("[smoke-server] smoke passed — the packaged server boots and serves.");
}

main().catch((err) => {
	console.error(`[smoke-server] FAIL: ${err.message}`);
	process.exit(1);
});
