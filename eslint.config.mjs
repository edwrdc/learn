import { defineConfig, globalIgnores } from "eslint/config";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";
import svelteParser from "svelte-eslint-parser";

/**
 * ESLint with one job here: enforce the import rules between feature
 * folders. Everything else stays out of the way.
 *
 *   src/<feature>/model/**  pure, browser-safe code: imports only other
 *                           features' model/ folders (and npm packages)
 *   src/<feature>/**        imports another feature only through its
 *                           index.ts or model/index.ts
 *   src/lib/**              imports only its own subtree and model/index.ts
 *   src/routes/**           imports lib, model/index.ts and feature index.ts
 *
 * tests/, scripts/ and electron/ are unrestricted.
 */

const FEATURES = ["platform", "tools", "settings", "graph", "jobs", "session"];
const modelIndexes = FEATURES.map((f) => `./${f}/model/index.ts`);
const featureIndexes = FEATURES.map((f) => `./${f}/index.ts`);

const zones = [
	...FEATURES.map((f) => ({
		target: `./src/${f}/model`,
		from: "./src",
		except: FEATURES.map((g) => `./${g}/model`),
		message: "model/ folders are pure: they import only other model/ folders.",
	})),
	...FEATURES.flatMap((f) =>
		FEATURES.filter((g) => g !== f).map((g) => ({
			target: `./src/${f}`,
			from: `./src/${g}`,
			except: ["./index.ts", "./model/index.ts"],
			message: `src/${f} imports src/${g} only through its index.ts or model/index.ts.`,
		})),
	),
	...FEATURES.map((f) => ({
		target: `./src/${f}`,
		from: ["./src/lib", "./src/routes"],
		message: "Feature code never imports the UI or the routes.",
	})),
	{
		target: "./src/lib",
		from: "./src",
		except: ["./lib", ...modelIndexes],
		message: "The UI imports only its own subtree and the features' model/index.ts.",
	},
	{
		target: "./src/routes/**/*.svelte",
		from: "./src",
		except: ["./routes", "./lib", ...modelIndexes],
		message: "Client route components import only lib and the features' model/index.ts.",
	},
	{
		target: "./src/routes",
		from: "./src",
		except: ["./routes", "./lib", "./stores.ts", "./boot.ts", ...modelIndexes, ...featureIndexes],
		message: "Routes import lib, model/index.ts and the features' index.ts.",
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
