/**
 * The packaged-server harness shared by the smoke gates: copy the payload
 * outside the worktree, boot it the way electron/main.cjs does, and tear it
 * down. Booted inside the checkout, Node resolves a package missing from the
 * payload out of the checkout's own node_modules, and a gate would pass a
 * payload that cannot run in the app.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { freePort } from "../electron/free-port.cjs";
import { probeEnv } from "./smoke-demo-runtime.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BOOT_TIMEOUT_MS = 30_000;

/** `--payload <dir>` (default dist-server/standalone) and `--electron`
 *  (Electron's bundled Node instead of the host Node). */
export function smokeOptions(tag, argv = process.argv.slice(2)) {
	const payloadIndex = argv.indexOf("--payload");
	const source = payloadIndex >= 0 ? path.resolve(argv[payloadIndex + 1]) : path.join(ROOT, "dist-server", "standalone");
	const electron = argv.includes("--electron");
	if (!fs.existsSync(path.join(source, "server.js"))) {
		console.error(`[${tag}] ${source}/server.js missing — run npm run build && node scripts/build-server.mjs first.`);
		process.exit(1);
	}
	return { source, electron, runtime: electron ? createRequire(import.meta.url)("electron") : process.execPath };
}

/** A payload copy under os.tmpdir() with no ancestor node_modules. */
export function isolatedPayload(source, prefix) {
	const isolated = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	for (let dir = path.dirname(isolated); ; dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, "node_modules"))) {
			fs.rmSync(isolated, { recursive: true, force: true });
			throw new Error(`the isolated payload would resolve packages from ${dir}/node_modules`);
		}
		if (path.dirname(dir) === dir) break;
	}
	fs.cpSync(source, isolated, { recursive: true });
	return isolated;
}

/** Boot the copied payload on a kernel-assigned 127.0.0.1 port with a
 *  throwaway LH_DATA_DIR/LH_AUTH_FILE, and wait until GET / answers 200.
 *  `stop()` always kills the child and deletes the copy and the data. */
export async function startPayloadServer({ standalone, runtime, electron, env = {} }) {
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-smoke-home-"));
	const dataDir = path.join(home, "data");
	const authFile = path.join(home, "auth.json");
	fs.writeFileSync(authFile, "{}\n", "utf-8");
	const logs = [];
	const child = spawn(runtime, [path.join(standalone, "server.js")], {
		cwd: standalone,
		env: {
			...probeEnv(process.env, home),
			...(electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
			NODE_ENV: "production",
			PORT: String(port),
			HOSTNAME: "127.0.0.1",
			LH_DATA_DIR: dataDir,
			LH_AUTH_FILE: authFile,
			...env,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
	child.stderr.on("data", (chunk) => logs.push(chunk.toString()));

	const stop = async () => {
		if (child.exitCode === null) {
			await new Promise((resolve) => {
				child.once("exit", resolve);
				child.kill("SIGTERM");
				setTimeout(() => {
					if (child.exitCode === null) child.kill("SIGKILL");
					resolve();
				}, 3_000);
			});
		}
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(standalone, { recursive: true, force: true });
	};
	const logTail = (lines = 40) => logs.join("").split("\n").filter((line) => line.trim()).slice(-lines);

	const deadline = Date.now() + BOOT_TIMEOUT_MS;
	let status = 0;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) break;
		status = await getStatus(url);
		if (status === 200) return { url, dataDir, stop, logTail };
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	const tail = logTail();
	await stop();
	throw new Error(
		`server never answered 200 on ${url} (last status: ${status})\n--- server log tail ---\n    ${tail.join("\n    ")}`,
	);
}

/** fetch with a deadline that stays armed: a body which stops writing is aborted too. */
export async function request(url, init = {}, timeoutMs = 10_000) {
	if (init.signal) return fetch(url, init);
	const controller = new AbortController();
	setTimeout(() => controller.abort(), timeoutMs).unref();
	return fetch(url, { ...init, signal: controller.signal });
}

/** One GET's status; 0 when the connection failed. */
export async function getStatus(url) {
	try {
		const res = await request(url, {}, 5_000);
		await res.arrayBuffer();
		return res.status;
	} catch {
		return 0;
	}
}

export function postJson(url, body) {
	return request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
