import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const requireMain = createRequire(mainFile);
const mainSource = readFileSync(mainFile, "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	author: { name: string; email: string };
	homepage: string;
	desktopName: string;
	dependencies: Record<string, string>;
	scripts: Record<string, string>;
};
const yaml = require("js-yaml") as { load(source: string): Record<string, any> };
const builderConfig = yaml.load(readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));

/** Decline the single-instance lock so normal boot never spawns a server.
 * Then call the REAL createWindow with a stub Electron API and inspect its
 * constructor options. No rewritten copy of the production logic. */
function windowOptions(platform: string) {
	class FakeWindow {
		constructor(readonly options: unknown) {}
		webContents = { on() {}, setWindowOpenHandler() {} };
		loadURL() {}
		once() {}
	}
	const electron = {
		app: { setName() {}, requestSingleInstanceLock: () => false, quit() {} },
		BrowserWindow: FakeWindow,
		session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
	};
	const context = {
		require: (id: string) => id === "electron" ? electron
			: id === "./free-port.cjs" ? requireMain("./free-port.cjs")
			: require(id),
		process: { platform, argv: [], env: {}, on() {} },
		__dirname: dirname(mainFile),
	};
	runInNewContext(mainSource, context, { filename: mainFile });
	const win = runInNewContext('createWindow("http://127.0.0.1:9000")', context) as FakeWindow;
	// The options originate in a VM realm; normalize prototypes for assertions.
	return JSON.parse(JSON.stringify(win.options));
}

describe("desktop window chrome", () => {
	it("macOS keeps the proven traffic lights and does not enable WCO", () => {
		const options = windowOptions("darwin");
		assert.equal(options.titleBarStyle, "hiddenInset");
		assert.deepEqual(options.trafficLightPosition, { x: 16, y: 22.5 });
		assert.equal(options.titleBarOverlay, undefined);
		assert.equal(options.autoHideMenuBar, undefined);
	});

	for (const platform of ["win32", "linux"]) {
		it(`${platform} uses native-height right-side controls with an Alt-accessible menu`, () => {
			const options = windowOptions(platform);
			assert.equal(options.titleBarStyle, "hidden");
			assert.deepEqual(options.titleBarOverlay, { color: "#141414", symbolColor: "#e5e5e5" });
			assert.equal(Object.hasOwn(options.titleBarOverlay, "height"), false, "omit height so the OS selects its native default");
			assert.equal(options.trafficLightPosition, undefined);
			assert.equal(options.autoHideMenuBar, true);
			assert.equal(options.webPreferences.contextIsolation, true);
			assert.equal(options.webPreferences.sandbox, true);
			assert.equal(options.webPreferences.nodeIntegration, false);
		});
	}

	it("preload exposes OS identity without exposing Node/Electron to the renderer", () => {
		let bridge: Record<string, unknown> = {};
		const context = {
			process: { platform: "win32" },
			require: () => ({
				contextBridge: {
					exposeInMainWorld(name: string, api: Record<string, unknown>) {
						assert.equal(name, "lh");
						bridge = api;
					},
				},
				ipcRenderer: {},
			}),
		};
		runInNewContext(readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8"), context);
		assert.equal(bridge.platform, "win32");
		assert.deepEqual(Object.keys(bridge).sort(), ["expandWindow", "getZoom", "onZoom", "platform"]);
	});
});

describe("desktop packaging policy", () => {
	it("configuration is accepted by the INSTALLED electron-builder schema", async () => {
		const { validateConfiguration } = require("app-builder-lib/out/util/config/config.js");
		await validateConfiguration(builderConfig, { isEnabled: false });
	});

	it("packages one Fedora Linux x64 RPM and nothing else", () => {
		assert.deepEqual(builderConfig.linux.target, [{ target: "rpm", arch: ["x64"] }]);
		assert.equal(builderConfig.linux.syncDesktopName, true);
		for (const key of ["mac", "win", "nsis", "dmg", "afterPack"]) {
			assert.equal(builderConfig[key], undefined, `${key} is obsolete packaging scope`);
		}
		assert.equal(builderConfig.publish, null, "explicit null disables electron-builder's inferred GitHub update feed");
		assert.equal(builderConfig.files.some((entry: string) => entry.includes("electron-updater")), false);
	});

	it("keeps the app identity the RPM installs", () => {
		assert.equal(builderConfig.appId, "com.learnharness.LearnHarness");
		assert.equal(builderConfig.productName, "LearnHarness");
		assert.equal(pkg.author.name, "Amos Blomqvist");
		assert.equal(pkg.author.email, "255718537+amosblomqvist@users.noreply.github.com");
		assert.equal(pkg.homepage, "https://github.com/amosblomqvist/learnharness");
		assert.equal(pkg.desktopName, "learnharness.desktop");
	});
});

describe("Fedora act workflow", () => {
	type Step = { uses?: string; with?: Record<string, unknown>; run?: string };
	type Job = { steps: Step[]; "runs-on"?: string; needs?: string };
	const workflow = yaml.load(readFileSync(new URL("../.act/workflows/fedora.yml", import.meta.url), "utf8")) as {
		jobs: Record<string, Job>;
	};

	it("runs both jobs on the mapped Fedora x64 label and proves the host", () => {
		const jobs = Object.values(workflow.jobs);
		assert.equal(jobs.length, 2);
		for (const job of jobs) {
			assert.equal(job["runs-on"], "fedora-44-x64");
			const boundary = job.steps[0]?.run ?? "";
			assert.ok(boundary.includes("/etc/os-release") && boundary.includes("fedora"));
			assert.ok(boundary.includes('uname -m') && boundary.includes("x86_64"));
		}
		assert.equal(workflow.jobs.package?.needs, "quality");
	});

	it("uses supported Action runtimes without changing the app's Node 26", () => {
		const expected = ["actions/checkout@v7", "actions/setup-node@v7"];
		for (const job of Object.values(workflow.jobs)) {
			const observed = new Set<string>();
			assert.ok(job.steps.some(step => step.run === "npm ci"), "each job installs its own dependencies");
			for (const step of job.steps) {
				if (!step.uses) continue;
				assert.ok(expected.includes(step.uses), `unexpected Action reference: ${step.uses}`);
				observed.add(step.uses);
				if (step.uses === "actions/setup-node@v7") {
					assert.equal(step.with?.["node-version"], "26");
					assert.equal(step.with?.cache, "npm");
				}
			}
			assert.deepEqual([...observed].sort(), [...expected].sort());
		}
	});

	it("retains the packaged gates and copies the RPM to the caller's output dir", () => {
		const steps = workflow.jobs.package!.steps;
		const native = steps.find(step => step.run?.includes("pdf-native-render.test.ts"));
		assert.ok(native?.run?.startsWith("npx electron --import tsx --test "));
		assert.ok(steps.some(step => step.run === "npm run desktop:dist"));
		assert.ok(steps.some(step => step.run?.includes("smoke-provider-runtime.mjs --standalone")));
		assert.ok(steps.some(step => step.run?.startsWith("xvfb-run -a node scripts/smoke-demo-runtime.mjs")));
		const copy = steps.at(-1)?.run ?? "";
		assert.ok(copy.includes("dist/*.rpm"));
		assert.ok(copy.includes("${LH_OUTPUT_DIR:?"));
		assert.ok(copy.includes("mkdir -p"));
		assert.ok(copy.includes("exit 1"), "a run without an RPM fails instead of passing");
	});

	it("proves the RPM tools and Xvfb exist before installing or building", () => {
		const steps = workflow.jobs.package!.steps;
		const prerequisite = steps.findIndex(step => step.run?.includes("rpm -q rpm-build libxcrypt-compat xorg-x11-server-Xvfb"));
		assert.ok(prerequisite > 0, "the package job checks its host tools");
		assert.ok(prerequisite < steps.findIndex(step => step.uses === "actions/checkout@v7"));
		assert.ok(prerequisite < steps.findIndex(step => step.run === "npm ci"));
	});
});

describe("local-only contract", () => {
	const workflowDir = new URL("../.github/workflows", import.meta.url);

	it("leaves GitHub no workflow to run", () => {
		const dir = fileURLToPath(workflowDir);
		if (!existsSync(dir)) return;
		assert.deepEqual(readdirSync(dir).filter(name => /\.ya?ml$/.test(name)), []);
	});

	it("builds and keeps the RPM locally without publishing or updating", () => {
		const dist = pkg.scripts["desktop:dist"] ?? "";
		assert.ok(dist.startsWith("rm -rf dist && "), "cleanup stays first so stale output cannot be validated");
		assert.ok(dist.endsWith("electron-builder --linux --x64 --publish never"));
		assert.ok(dist.includes("node scripts/smoke-carrier.mjs"), "desktop:dist owns the carrier gate");
		for (const smoke of ["smoke-server", "smoke-carrier"]) {
			const gate = `node scripts/${smoke}.mjs --electron`;
			assert.ok(dist.includes(gate), `${gate} runs on Electron's bundled Node`);
			assert.ok(dist.indexOf(gate) < dist.indexOf("electron-builder"), `${gate} gates the artifact`);
		}
		const act = pkg.scripts["desktop:act"] ?? "";
		assert.ok(act.includes("-W .act/workflows/fedora.yml"));
		assert.ok(act.includes("-P fedora-44-x64=-self-hosted"));
		assert.ok(act.includes('--env "LH_OUTPUT_DIR=$PWD/dist"'));
		assert.ok(!act.includes("--publish"));
		for (const script of Object.values(pkg.scripts)) assert.ok(!script.includes("--publish always"));
		assert.equal("electron-updater" in pkg.dependencies, false);
		for (const file of ["../electron/main.cjs", "../electron/preload.cjs"]) {
			const source = readFileSync(new URL(file, import.meta.url), "utf8");
			for (const marker of ["electron-updater", "lh:update-status", "lh:update-install"]) {
				assert.equal(source.includes(marker), false, `${file} still references ${marker}`);
			}
		}
	});
});
