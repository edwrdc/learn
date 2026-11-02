/** Run the real payload-curation script in throwaway repository fixtures. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fs.realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const script = fs.readFileSync(path.join(ROOT, "scripts", "build-server.mjs"), "utf8");
const launcher = fs.readFileSync(path.join(ROOT, "scripts", "server-launch.mjs"), "utf8");
const { RUNTIME_EXTERNALS } = await import("../scripts/build-server.mjs");
const BUILD = "dist-server";
const PAYLOAD = path.join(BUILD, "standalone");
const PROMPT = path.join("src", "agent", "system-prompt.md");

type Fixture = {
	root: string;
	write: (relative: string, content?: string) => void;
	pkg: (name: string, extra?: Record<string, unknown>) => void;
	remove: (relative: string) => void;
	run: () => ReturnType<typeof spawnSync>;
};

function withPayload(test: (fixture: Fixture) => void) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-payload-test-"));
	const write = (relative: string, content = "fixture") => {
		const target = path.join(root, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	};
	const remove = (relative: string) => fs.rmSync(path.join(root, relative), { recursive: true, force: true });

	write(path.join("scripts", "build-server.mjs"), script);
	write(path.join("scripts", "server-launch.mjs"), launcher);
	write("package.json", JSON.stringify({ name: "learnharness", version: "9.9.9", private: true }));
	write(path.join(BUILD, "handler.js"), 'import "@earendil-works/pi-ai";\nexport const handler = () => {};\n');
	write(path.join(BUILD, "env.js"), "export {};\n");
	write(path.join(BUILD, "index.js"), "// adapter entry point the payload never uses\n");
	write(path.join(BUILD, "server", "chunks", "server.js"), "export {};\n");
	write(path.join(BUILD, "client", "fonts", "lh.ttf"), "font-bytes");
	write(PROMPT, "# system prompt\n");
	write(path.join("src", "agent", "prompts", "teacher", "20-teaching.md"), "# teaching\n");

	const pkg = (name: string, extra: Record<string, unknown> = {}) =>
		write(
			path.join("node_modules", name, "package.json"),
			JSON.stringify({ name, version: "1.0.0", ...extra }),
		);
	for (const name of RUNTIME_EXTERNALS) pkg(name);
	// The two native bindings resolve their platform binary through optionalDependencies.
	pkg("@napi-rs/canvas", { optionalDependencies: { "@napi-rs/canvas-linux-x64-gnu": "1.0.0" } });
	pkg("@napi-rs/canvas-linux-x64-gnu");
	pkg("@resvg/resvg-js", { optionalDependencies: { "@resvg/resvg-js-linux-x64-gnu": "1.0.0" } });
	pkg("@resvg/resvg-js-linux-x64-gnu");
	// build-server parses the built server with the installed TypeScript; a
	// dev-tool symlink is enough and must not end up in the payload.
	fs.symlinkSync(
		path.dirname(require.resolve("typescript/package.json")),
		path.join(root, "node_modules", "typescript"),
		process.platform === "win32" ? "junction" : "dir",
	);

	try {
		test({
			root,
			write,
			pkg,
			remove,
			run: () =>
				spawnSync(process.execPath, [path.join(root, "scripts", "build-server.mjs")], {
					cwd: root,
					encoding: "utf8",
					timeout: 30_000,
				}),
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("desktop standalone payload", () => {

	it("preserves existing payload records and auth even when the adapter build is missing", () => {
		for (const entry of [path.join("data", "chats", "canary.json"), "auth.json"]) {
			for (const missingBuild of [false, true]) {
				withPayload(({ root, write, remove, run }) => {
					const protectedFile = path.join(PAYLOAD, entry);
					write(protectedFile, "do-not-delete");
					if (missingBuild) remove(path.join(BUILD, "handler.js"));
					const result = run();
					assert.equal(result.status, 1);
					assert.match(String(result.stderr), /REFUSING: existing/);
					assert.equal(fs.readFileSync(path.join(root, protectedFile), "utf8"), "do-not-delete");
				});
			}
		}
	});
	it("curates the adapter output into a self-contained ESM payload", () => {
		withPayload(({ root, run }) => {
			const result = run();
			assert.equal(result.status, 0, String(result.stderr));
			assert.match(String(result.stdout), /server payload ready/);

			const payload = path.join(root, PAYLOAD);
			assert.equal(fs.readFileSync(path.join(payload, "server.js"), "utf8"), launcher);
			assert.equal(JSON.parse(fs.readFileSync(path.join(payload, "package.json"), "utf8")).type, "module");
			assert.ok(fs.existsSync(path.join(payload, "handler.js")));
			assert.ok(fs.existsSync(path.join(payload, "client", "fonts", "lh.ttf")));
			assert.ok(!fs.existsSync(path.join(payload, "index.js")), "the adapter's own entry is replaced by server.js");
			for (const name of RUNTIME_EXTERNALS) {
				assert.ok(fs.existsSync(path.join(payload, "node_modules", name, "package.json")), name);
			}
			assert.ok(fs.existsSync(path.join(payload, "node_modules", "@napi-rs", "canvas-linux-x64-gnu")));
			assert.ok(!fs.existsSync(path.join(payload, "node_modules", "typescript")), "the build tool never ships");
			assert.ok(fs.existsSync(path.join(payload, PROMPT)));
			assert.ok(fs.existsSync(path.join(payload, "src", "agent", "prompts", "teacher", "20-teaching.md")));
		});
	});

	it("ships a real server import that is not a declared runtime external", () => {
		withPayload(({ root, write, pkg, run }) => {
			assert.ok(!RUNTIME_EXTERNALS.includes("clsx"));
			pkg("clsx");
			write(path.join(BUILD, "server", "chunks", "chunks", "render.js"), 'import clsx from "clsx";\nexport const merged = clsx;\n');
			const result = run();
			assert.equal(result.status, 0, String(result.stderr));
			assert.ok(fs.existsSync(path.join(root, PAYLOAD, "node_modules", "clsx", "package.json")), "clsx ships");
		});
	});

	it("ignores import-shaped text in comments, strings and templates", () => {
		withPayload(({ root, write, pkg, run }) => {
			pkg("clsx");
			write(
				path.join(BUILD, "server", "chunks", "chunks", "noise.js"),
				[
					'// import ghost from "comment-pkg";',
					'/* export { ghost } from "block-comment-pkg"; */',
					'const text = `import("template-pkg")`;',
					'const other = \'require("string-pkg")\';',
					'export const ready = import("clsx");',
				].join("\n"),
			);
			const result = run();
			assert.equal(result.status, 0, String(result.stderr));
			assert.ok(fs.existsSync(path.join(root, PAYLOAD, "node_modules", "clsx", "package.json")), "the literal dynamic import ships");
			for (const ghost of ["comment-pkg", "block-comment-pkg", "template-pkg", "string-pkg"]) {
				assert.ok(!fs.existsSync(path.join(root, PAYLOAD, "node_modules", ghost)), `${ghost} is not a module`);
			}
		});
	});

	it("keeps root and nested installed versions resolvable where the checkout resolves them", () => {
		withPayload(({ root, write, pkg, run }) => {
			pkg("gaxios", { version: "7.3.1", dependencies: { "https-proxy-agent": "^7.0.1" } });
			pkg("https-proxy-agent", { version: "7.0.6" });
			pkg("@earendil-works/pi-ai", { version: "1.4.0", dependencies: { "https-proxy-agent": "^9.0.0" } });
			write(
				path.join("node_modules", "@earendil-works", "pi-ai", "node_modules", "https-proxy-agent", "package.json"),
				JSON.stringify({ name: "https-proxy-agent", version: "9.1.0" }),
			);
			write(path.join(BUILD, "server", "chunks", "chunks", "http.js"), 'import "gaxios";\nexport {};\n');
			const result = run();
			assert.equal(result.status, 0, String(result.stderr));

			const payload = path.join(root, PAYLOAD);
			const resolveFrom = (from: string) => path.resolve(createRequire(from).resolve("https-proxy-agent/package.json"));
			const versionAt = (resolved: string) => JSON.parse(fs.readFileSync(resolved, "utf8")).version;
			const top = resolveFrom(path.join(payload, "handler.js"));
			const nested = resolveFrom(path.join(payload, "node_modules", "@earendil-works", "pi-ai", "package.json"));
			assert.ok(top.startsWith(payload + path.sep), "gaxios resolves inside the payload");
			assert.ok(nested.startsWith(payload + path.sep), "pi-ai resolves inside the payload");
			assert.equal(versionAt(top), "7.0.6", "gaxios keeps its declared major");
			assert.equal(versionAt(nested), "9.1.0", "pi-ai keeps its private copy");
		});
	});

	it("fails and deletes the half payload when a server import is not installed", () => {
		withPayload(({ root, write, run }) => {
			write(path.join(BUILD, "server", "chunks", "chunks", "missing.js"), 'import "ghost-pkg";\nexport {};\n');
			const result = run();
			assert.equal(result.status, 1);
			assert.match(String(result.stderr), /runtime dependency missing from node_modules: ghost-pkg/);
			assert.ok(!fs.existsSync(path.join(root, PAYLOAD, "server.js")), "refusal leaves no half payload to package");
		});
	});

	it("never copies the repository checkout", () => {
		withPayload(({ root, write, run }) => {
			for (const file of ["components/chat.tsx", "tests/probe.test.ts", "docs/guide.md", "AGENTS.md", "app/globals.css"]) {
				write(file);
			}
			const result = run();
			assert.equal(result.status, 0, String(result.stderr));
			for (const entry of ["components", "tests", "docs", "app", "AGENTS.md"]) {
				assert.ok(!fs.existsSync(path.join(root, PAYLOAD, entry)), `${entry} must not ship`);
			}
		});
	});

	it("refuses a payload carrying developer data, secrets or agent sources", () => {
		const leaks: Array<[string, string]> = [
			[path.join("client", "auth.json"), "auth.json"],
			[path.join("client", ".env"), ".env"],
			[path.join("client", ".env.local"), ".env.local"],
			[path.join("client", "data", "private.json"), "data/"],
			[path.join("app", "page.html"), "app/"],
			[path.join("next.config.ts"), "next.config.ts"],
			[path.join("src", "agent", "secret.ts"), ".ts sources"],
		];
		for (const [leak, expected] of leaks) {
			withPayload(({ write, run }) => {
				write(path.join(BUILD, leak));
				const result = run();
				assert.equal(result.status, 1, leak);
				assert.match(String(result.stderr), /REFUSING/);
				assert.match(String(result.stderr), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			});
		}
	});

	it("still refuses a missing runtime prompt asset", () => {
		withPayload(({ root, remove, run }) => {
			remove(path.join("src", "agent", "prompts", "teacher", "20-teaching.md"));
			const result = run();
			assert.equal(result.status, 1);
			assert.match(String(result.stderr), /prompt asset missing/);
		});
	});

	it("still refuses a payload without the platform-native binding", () => {
		withPayload(({ root, remove, run }) => {
			remove(path.join("node_modules", "@resvg", "resvg-js-linux-x64-gnu"));
			const result = run();
			assert.equal(result.status, 1);
			assert.match(String(result.stderr), /platform-native package missing/);
			assert.ok(!fs.existsSync(path.join(root, PAYLOAD, "server.js")), "refusal leaves no half payload to package");
		});
	});

	it("refuses before curation when the adapter build is missing", () => {
		withPayload(({ remove, run }) => {
			remove(path.join(BUILD, "handler.js"));
			const result = run();
			assert.equal(result.status, 1);
			assert.match(String(result.stderr), /run `npm run build` first/);
		});
	});

	it("is idempotent", () => {
		withPayload(({ run }) => {
			for (let i = 0; i < 2; i++) {
				const result = run();
				assert.equal(result.status, 0, String(result.stderr));
				assert.match(String(result.stdout), /server payload ready/);
			}
		});
	});
});
