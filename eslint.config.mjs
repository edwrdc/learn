import { defineConfig, globalIgnores } from "eslint/config";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";
import svelteParser from "svelte-eslint-parser";

/**
 * ESLint with one job here: ENFORCE THE IMPORT LAW (the shell/core
 * architecture, docs/architecture.md). Everything else stays out of the
 * way — this is not a style linter.
 *
 *   src/core/**    →  never imports src/agent, src/server, src/store (pure
 *                    core: adapters implement core/ports.ts, never the reverse)
 *   src/agent/**   →  never imports src/server, src/store (dependencies —
 *                    the storage ports, the composition — arrive via
 *                    factories/closures from the chat-handler)
 *
 * tests/ and scripts/ are internal — unrestricted.
 */

const zones = [
	{
		target: "./src/lib",
		from: "./src",
		// NOTE: exceptions resolve relative to `from` — its own subtree and the
		// one public core module; every other src file is forbidden.
		except: ["./lib", "./core/index.ts"],
		message:
			"Browser shell imports ONLY its own subtree and the pure core barrel: `from \"@/src/core\"` (architecture: docs/architecture.md).",
	},
	{
		target: "./src/routes",
		from: "./src",
		except: ["./routes", "./lib", "./core/index.ts", "./server/index.ts"],
		message:
			"src/routes (transport + server loads) imports ONLY its own subtree, `$lib`, and the barrels: `@/src/core` and `@/src/server` (architecture: docs/architecture.md).",
	},
	{
		// Client route components may never reach the server layer, even
		// through the barrel: only +page.server.ts / +server.ts own transport.
		target: "./src/routes/**/*.svelte",
		from: "./src/server",
		message:
			"Client route components never import the server layer; server data arrives through +page.server.ts (architecture: docs/architecture.md).",
	},
	{
		target: "./src/core",
		from: ["./src/agent", "./src/server", "./src/store"],
		message:
			"Pure core never imports IO layers (agent/server/store): adapters implement core/ports.ts, and the composition root (src/server/stores.ts) passes them in (architecture: docs/architecture.md).",
	},
	{
		target: "./src/agent",
		from: ["./src/server", "./src/store"],
		message:
			"The agent layer receives its dependencies (storage ports via factories/closures) — it never imports the server layer or store adapters (architecture: docs/architecture.md).",
	},
];

export default defineConfig([
	// electron/** — the desktop shell: plain Node, no framework, outside the
	// import law (same rationale as scripts/).
	globalIgnores([
		".agents/**",
		".next/**",
		".svelte-kit/**",
		"dist-server/**",
		"node_modules/**",
		"data/**",
		"scripts/**",
		"electron/**",
		"dist/**",
	]),
	{
		files: ["**/*.{js,mjs,ts}"],
		languageOptions: {
			parser: tsParser,
			parserOptions: { ecmaVersion: "latest", sourceType: "module" },
		},
		plugins: { import: importPlugin },
		settings: {
			"import/resolver": { typescript: { alwaysTryTypes: true } },
		},
		rules: {
			"import/no-restricted-paths": ["error", { zones }],
		},
	},
	{
		files: ["**/*.svelte"],
		languageOptions: {
			parser: svelteParser,
			parserOptions: { parser: tsParser },
		},
		plugins: { import: importPlugin },
		settings: {
			"import/resolver": { typescript: { alwaysTryTypes: true } },
		},
		rules: {
			"import/no-restricted-paths": ["error", { zones }],
		},
	},
]);
