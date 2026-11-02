import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const LOAD_ENV = pathToFileURL(path.join(REPO_ROOT, "scripts", "load-env.mjs")).href;
const DEV_FRESH = path.join(REPO_ROOT, "scripts", "dev-fresh.sh");

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "lh-source-startup-"));

function loadInChild(
	mode: string,
	envDir: string | false | undefined,
	cwd: string,
	shell: Record<string, string>,
	keys: string[],
): Record<string, string | null> {
	const source = `
		const { loadProcessEnv } = await import(${JSON.stringify(LOAD_ENV)});
		loadProcessEnv(${JSON.stringify(mode)}, ${JSON.stringify(envDir)});
		const keys = ${JSON.stringify(keys)};
		console.log(JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]))));
	`;
	const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
		cwd,
		env: { PATH: process.env.PATH ?? "", ...shell },
		encoding: "utf8",
	});
	return JSON.parse(stdout) as Record<string, string | null>;
}

describe("source env bridge", () => {
	it("refuses compilation before the adapter can clear misplaced data or auth", () => {
		const root = tempDir();
		try {
			for (const name of ["src", "package.json", "svelte.config.js", "vite.config.ts", "postcss.config.mjs"]) {
				fs.cpSync(path.join(REPO_ROOT, name), path.join(root, name), { recursive: true });
			}
			fs.mkdirSync(path.join(root, "scripts"));
			for (const name of ["load-env.mjs", "build-server.mjs"]) fs.copyFileSync(path.join(REPO_ROOT, "scripts", name), path.join(root, "scripts", name));
			fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
			const payload = path.join(root, "dist-server", "standalone");
			const data = path.join(payload, "data", "canary.json");
			const auth = path.join(payload, "auth.json");
			fs.mkdirSync(path.dirname(data), { recursive: true });
			fs.writeFileSync(data, "preserve data bytes");
			fs.writeFileSync(auth, "preserve auth bytes");
			const result = spawnSync(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build"], {
				cwd: root, env: { PATH: process.env.PATH ?? "", HOME: root, LH_IGNORE_ENV_KEYS: "1" }, encoding: "utf8", timeout: 30_000,
			});
			assert.notEqual(result.status, 0);
			assert.match(result.stdout + result.stderr, /REFUSING: existing data/);
			assert.equal(fs.readFileSync(data, "utf8"), "preserve data bytes");
			assert.equal(fs.readFileSync(auth, "utf8"), "preserve auth bytes");
			const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
			assert.ok(!manifest.scripts["desktop:dist"].split("&&")[0].includes("dist-server"));
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("keeps source data and auth outside regenerated output before curation", () => {
		for (const variant of ["default", "empty", "shell", "file"]) {
			const root = tempDir();
			try {
				fs.mkdirSync(path.join(root, "scripts"));
				fs.mkdirSync(path.join(root, "dist-server", "standalone"), { recursive: true });
				for (const name of ["start-server.mjs", "load-env.mjs"]) {
					fs.copyFileSync(path.join(REPO_ROOT, "scripts", name), path.join(root, "scripts", name));
				}
				fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
				fs.writeFileSync(path.join(root, "scripts", "build-server.mjs"), 'export function buildPayload() { globalThis.atBuild = { data: process.env.LH_DATA_DIR, auth: process.env.LH_AUTH_FILE }; }');
				fs.writeFileSync(path.join(root, "dist-server", "standalone", "server.js"), 'console.log(JSON.stringify({ atBuild: globalThis.atBuild, data: process.env.LH_DATA_DIR, auth: process.env.LH_AUTH_FILE }));');
				if (variant !== "default") fs.writeFileSync(path.join(root, ".env.production"), "LH_DATA_DIR=file-data\nLH_AUTH_FILE=file-auth.json\n");
				const shell = variant === "empty" ? { LH_DATA_DIR: "", LH_AUTH_FILE: "" } : variant === "shell" ? { LH_DATA_DIR: "shell-data", LH_AUTH_FILE: "shell-auth.json" } : {};
				const output = execFileSync(process.execPath, [path.join(root, "scripts", "start-server.mjs")], {
					cwd: root, env: { PATH: process.env.PATH ?? "", ...shell }, encoding: "utf8",
				});
				const data = variant === "shell" ? "shell-data" : variant === "file" ? "file-data" : path.join(root, "data");
				const auth = variant === "shell" ? "shell-auth.json" : variant === "file" ? "file-auth.json" : path.join(root, "auth.json");
				assert.deepEqual(JSON.parse(output), { atBuild: { data, auth }, data, auth }, variant);
			} finally { fs.rmSync(root, { recursive: true, force: true }); }
		}
	});
	it("loads .env files with Vite priority and interpolation, real env wins", () => {
		const dir = tempDir();
		const files: Record<string, string> = {
			".env": "BASE=base\nFROM_BASE=one\nBASE_VS_LOCAL=from-base\nDERIVED=${BASE}-x\nEMPTY=from-file\nSHARED_SHELL=from-file\n",
			".env.local": "FROM_LOCAL=two\nBASE_VS_LOCAL=from-local\nLOCAL_VS_MODE=from-local\n",
			".env.test": "FROM_MODE=three\nLOCAL_VS_MODE=from-mode\nMODE_VS_MODE_LOCAL=from-mode\n",
			".env.test.local": "FROM_MODE_LOCAL=four\nMODE_VS_MODE_LOCAL=from-mode-local\n",
		};
		for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
		const before = Object.keys(files).map((name) => fs.readFileSync(path.join(dir, name), "utf8"));

		const env = loadInChild("test", dir, dir, { SHARED_SHELL: "from-shell", EMPTY: "" }, [
			"FROM_BASE",
			"FROM_LOCAL",
			"FROM_MODE",
			"FROM_MODE_LOCAL",
			"BASE_VS_LOCAL",
			"LOCAL_VS_MODE",
			"MODE_VS_MODE_LOCAL",
			"DERIVED",
			"EMPTY",
			"SHARED_SHELL",
		]);

		assert.deepEqual(env, {
			FROM_BASE: "one",
			FROM_LOCAL: "two",
			FROM_MODE: "three",
			FROM_MODE_LOCAL: "four",
			BASE_VS_LOCAL: "from-local",
			LOCAL_VS_MODE: "from-mode",
			MODE_VS_MODE_LOCAL: "from-mode-local",
			DERIVED: "base-x",
			EMPTY: "",
			SHARED_SHELL: "from-shell",
		});
		assert.deepEqual(
			Object.keys(files).map((name) => fs.readFileSync(path.join(dir, name), "utf8")),
			before,
			"env files are read, never rewritten",
		);
	});

	it("envDir false skips every env file", () => {
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, ".env"), "LEAK_SENTINEL=leak\n");
		assert.equal(loadInChild("test", false, dir, {}, ["LEAK_SENTINEL"]).LEAK_SENTINEL, null);
	});

	it("defaults envDir to the working directory", () => {
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, ".env"), "CWD_SENTINEL=cwd\n");
		assert.equal(loadInChild("test", undefined, dir, {}, ["CWD_SENTINEL"]).CWD_SENTINEL, "cwd");
	});
});

function devFreshCopy(): string {
	const root = tempDir();
	fs.mkdirSync(path.join(root, "scripts"));
	fs.copyFileSync(DEV_FRESH, path.join(root, "scripts", "dev-fresh.sh"));
	return root;
}

function mockNpm(root: string, body: string): string {
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, "npm"), `#!/usr/bin/env bash\n${body}`, { mode: 0o755 });
	return `${bin}:${process.env.PATH ?? ""}`;
}

describe("dev:fresh launcher", () => {
	it("passes the dedicated port to vite and keeps the fresh-user env", () => {
		const root = devFreshCopy();
		const argvFile = path.join(root, "argv");
		const envFile = path.join(root, "env");
		const pathEnv = mockNpm(
			root,
			[
				`printf '%s\\n' "$@" > "${argvFile}"`,
				`printf 'LH_DATA_DIR=%s\\nLH_AUTH_FILE=%s\\nLH_IGNORE_ENV_KEYS=%s\\nPORT=%s\\n' "$LH_DATA_DIR" "$LH_AUTH_FILE" "$LH_IGNORE_ENV_KEYS" "$PORT" > "${envFile}"`,
			].join("\n"),
		);
		const port = 31337;

		const result = spawnSync("bash", [path.join(root, "scripts", "dev-fresh.sh"), "--port", String(port)], {
			cwd: root,
			env: { PATH: pathEnv },
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(fs.readFileSync(argvFile, "utf8").trim().split("\n"), ["run", "dev", "--", "--port", String(port)]);

		const env = Object.fromEntries(
			fs.readFileSync(envFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => {
					const at = line.indexOf("=");
					return [line.slice(0, at), line.slice(at + 1)];
				}),
		);
		assert.equal(env.LH_DATA_DIR, path.join(root, ".fresh-data"));
		assert.equal(env.LH_AUTH_FILE, path.join(root, ".fresh-data", "auth.json"));
		assert.equal(env.LH_IGNORE_ENV_KEYS, "1");
		assert.equal(env.PORT, String(port));
	});

	it("rejects a standing port before creating the scratch dir", () => {
		const root = devFreshCopy();
		const pathEnv = mockNpm(root, "exit 0");
		const result = spawnSync("bash", [path.join(root, "scripts", "dev-fresh.sh"), "--port", "3000"], {
			cwd: root,
			env: { PATH: pathEnv },
			encoding: "utf8",
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /standing assignment/);
		assert.equal(fs.existsSync(path.join(root, ".fresh-data")), false);
	});
});
