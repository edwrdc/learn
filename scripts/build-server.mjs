import * as fs from "node:fs";
import { builtinModules } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUILD = path.join(ROOT, "dist-server");
const PAYLOAD = path.join(BUILD, "standalone");
const NODE_MODULES = path.join(ROOT, "node_modules");

export const RUNTIME_EXTERNALS = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-durable",
	"@earendil-works/chord",
	"@earendil-works/pi-telemetry",
	"pdfjs-dist",
	"@napi-rs/canvas",
	"@resvg/resvg-js",
	"puppeteer-core",
];

const RUNTIME_ASSETS = [path.join("src", "session", "system-prompt.md"), path.join("src", "session", "prompts")];

const PROMPT_ASSETS = [
	path.join("src", "session", "system-prompt.md"),
	path.join("src", "session", "prompts", "teacher", "20-teaching.md"),
];

const FORBIDDEN_ENTRIES = ["app", "components", "tests", "docs", "AGENTS.md", "next.config.ts"];

const BUILTINS = new Set(builtinModules);

const exists = (p) => fs.existsSync(p);
const fail = (message) => {
	console.error(`[build-server] REFUSING: ${message}`);
	fs.rmSync(PAYLOAD, { recursive: true, force: true });
	process.exit(1);
};

function walk(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		return entry.isDirectory() ? walk(full) : [full];
	});
}

function packageName(specifier) {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function serverOutputs() {
	return fs
		.readdirSync(BUILD, { withFileTypes: true })
		.filter((entry) => entry.name !== "standalone" && entry.name !== "client" && entry.name !== "index.js")
		.flatMap((entry) => (entry.isDirectory() ? walk(path.join(BUILD, entry.name)) : [path.join(BUILD, entry.name)]))
		.filter((file) => /\.(?:m?js|cjs)$/.test(file));
}

function serverImports() {
	const specifiers = new Set();
	const specifierOf = (node) => {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			return node.moduleSpecifier.text;
		}
		if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
			const callee = node.expression;
			if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
				return node.arguments[0].text;
			}
		}
		return null;
	};
	for (const file of serverOutputs()) {
		const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
		const visit = (node) => {
			const specifier = specifierOf(node);
			if (specifier && !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.includes(":")) {
				if (!BUILTINS.has(packageName(specifier))) specifiers.add(specifier);
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return [...specifiers];
}

function findPackage(name, from, root = ROOT) {
	for (let dir = from; ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, "node_modules", name);
		if (exists(path.join(candidate, "package.json"))) return candidate;
		if (dir === root || path.dirname(dir) === dir) return null;
	}
}

const manifestOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));

const payloadDir = (installed) => path.join(PAYLOAD, "node_modules", path.relative(NODE_MODULES, installed));

// Key by installed directory so nested versions keep their original resolution paths.
function dependencyClosure(roots) {
	const copies = new Map();
	const queue = [...roots].map((name) => ({ name, from: ROOT, optional: false }));
	while (queue.length > 0) {
		const { name, from, optional } = queue.shift();
		const dir = findPackage(name, from);
		if (!dir) {
			if (optional) continue;
			fail(`runtime dependency missing from node_modules: ${name}`);
		}
		if (!dir.startsWith(NODE_MODULES + path.sep)) fail(`runtime dependency outside node_modules: ${dir}`);
		if (copies.has(dir)) continue;
		copies.set(dir, packageName(name));
		const manifest = manifestOf(dir);
		for (const dep of Object.keys(manifest.dependencies ?? {})) queue.push({ name: dep, from: dir, optional: false });
		for (const dep of Object.keys(manifest.optionalDependencies ?? {})) queue.push({ name: dep, from: dir, optional: true });
		for (const dep of Object.keys(manifest.peerDependencies ?? {})) queue.push({ name: dep, from: dir, optional: true });
	}
	return copies;
}

export function assertNoPayloadData() {
	for (const entry of ["data", "auth.json"]) {
		if (exists(path.join(PAYLOAD, entry))) {
			throw new Error(`[build-server] REFUSING: existing ${entry} in ${PAYLOAD}; move it outside the generated payload before rebuilding.`);
		}
	}
}

export function buildPayload() {
	assertNoPayloadData();
	if (!exists(path.join(BUILD, "handler.js"))) {
		fail(`dist-server/handler.js missing — run \`npm run build\` first (adapter-node output).`);
	}

	fs.rmSync(PAYLOAD, { recursive: true, force: true });
	fs.mkdirSync(PAYLOAD, { recursive: true });

	for (const entry of fs.readdirSync(BUILD, { withFileTypes: true })) {
		if (entry.name === "standalone" || entry.name === "index.js") continue;
		fs.cpSync(path.join(BUILD, entry.name), path.join(PAYLOAD, entry.name), { recursive: true });
	}

	fs.copyFileSync(path.join(ROOT, "scripts", "server-launch.mjs"), path.join(PAYLOAD, "server.js"));
	const manifest = manifestOf(ROOT);
	fs.writeFileSync(
		path.join(PAYLOAD, "package.json"),
		`${JSON.stringify({ name: manifest.name, version: manifest.version, private: true, type: "module" }, null, "\t")}\n`,
	);

	for (const asset of RUNTIME_ASSETS) {
		fs.cpSync(path.join(ROOT, asset), path.join(PAYLOAD, asset), { recursive: true });
	}

	const imports = serverImports();
	const closure = dependencyClosure([...RUNTIME_EXTERNALS, ...imports.map(packageName)]);
	for (const installed of closure.keys()) {
		fs.cpSync(installed, payloadDir(installed), { recursive: true });
	}

	verifyPayload(closure, imports);

	const bytes = walk(PAYLOAD).reduce((sum, file) => sum + fs.statSync(file).size, 0);
	console.log(
		`[build-server] server payload ready: ${PAYLOAD} (${Math.round(bytes / 1024 / 1024)}MB, ${closure.size} package directories, ${imports.length} server imports)`,
	);
	return PAYLOAD;
}

function verifyPayload(closure, imports) {
	for (const dataDir of ["data", path.join("client", "data")]) {
		if (exists(path.join(PAYLOAD, dataDir))) {
			fail(`payload contains ${dataDir.split(path.sep).join("/")}/ — repo session data would ship in the app.`);
		}
	}

	for (const file of walk(PAYLOAD)) {
		const base = path.basename(file);
		if (base === "auth.json" || base === ".env" || base.startsWith(".env.")) {
			fail(`payload contains ${path.relative(PAYLOAD, file)} — secrets would ship in the app.`);
		}
	}

	for (const entry of FORBIDDEN_ENTRIES) {
		if (exists(path.join(PAYLOAD, entry))) fail(`payload contains ${entry}/ — the repo checkout would ship.`);
	}
	if (walk(PAYLOAD).some((file) => file.endsWith(".tsx"))) fail("payload contains .tsx sources — the repo checkout would ship.");
	if (walk(PAYLOAD).some((file) => file.startsWith(path.join(PAYLOAD, "src")) && file.endsWith(".ts"))) {
		fail("payload contains .ts sources — only the markdown prompt assets belong there.");
	}

	for (const asset of PROMPT_ASSETS) {
		if (!exists(path.join(PAYLOAD, asset))) fail(`prompt asset missing from the payload: ${asset}`);
	}

	for (const specifier of imports) {
		if (!findPackage(packageName(specifier), PAYLOAD, PAYLOAD)) {
			fail(`${specifier} is imported by the built server but absent from the payload.`);
		}
	}
	for (const installed of closure.keys()) {
		const copied = payloadDir(installed);
		const manifest = manifestOf(installed);
		const deps = [
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.optionalDependencies ?? {}),
			...Object.keys(manifest.peerDependencies ?? {}),
		];
		for (const dep of deps) {
			if (!findPackage(dep, installed)) continue;
			if (!findPackage(dep, copied, PAYLOAD)) {
				fail(`the payload copy of ${closure.get(installed)} cannot resolve ${dep}.`);
			}
		}
	}
	for (const pattern of [/^@napi-rs\/canvas-[^/]+$/, /^@resvg\/resvg-js-[^/]+$/]) {
		if (![...closure.values()].some((name) => pattern.test(name))) {
			fail(`platform-native package missing from the payload: ${pattern}`);
		}
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	buildPayload();
}
