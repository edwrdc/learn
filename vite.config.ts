import { fileURLToPath } from "node:url";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, type Plugin } from "vite";
import { loadProcessEnv } from "./scripts/load-env.mjs";
import { assertNoPayloadData } from "./scripts/build-server.mjs";

/**
 * The pi engine (and its SQLite/native/telemetry closure) must stay OUTSIDE
 * the server bundle: its providers are runtime-loaded Node code, and the
 * durable store opens node:sqlite through runtime-resolved paths.
 */
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

/** core/coverage.ts and core/graph.ts use node:crypto for server-side
 *  hashing/ids, but the browser imports the shared core barrel. Only the
 *  CLIENT build (and only for core's own imports) gets the throwing shim;
 *  the SSR build and every server-layer importer keep the real module. */
function nodeCryptoClientShim(): Plugin {
	const shim = fileURLToPath(new URL("./src/lib/shims/node-crypto.ts", import.meta.url));
	return {
		name: "lh-node-crypto-client-shim",
		enforce: "pre",
		resolveId(source, importer, options) {
			if (source !== "node:crypto" || options?.ssr !== false) return null;
			if (!importer?.includes("/src/") || importer.includes("/src/lib/")) return null;
			return shim;
		},
	};
}

function sourceEnv(): Plugin {
	return {
		name: "lh-source-env",
		configResolved(config) {
			if (config.command === "build") assertNoPayloadData();
			if (config.envDir !== false) loadProcessEnv(config.mode, config.envDir);
		},
	};
}

export default defineConfig({
	plugins: [sourceEnv(), nodeCryptoClientShim(), sveltekit()],
	// Desktop dev parity: electron/main.cjs's LH_DEV_URL expects :3000.
	server: { port: 3000, strictPort: true },
	ssr: { external: RUNTIME_EXTERNALS },
});
