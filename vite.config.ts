import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, type Plugin } from "vite";
import { loadProcessEnv } from "./scripts/load-env.mjs";
import { assertNoPayloadData, RUNTIME_EXTERNALS } from "./scripts/build-server.mjs";

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
	plugins: [sourceEnv(), sveltekit()],
	// Desktop dev parity: electron/main.cjs's LH_DEV_URL expects :3000.
	server: { port: 3000, strictPort: true },
	ssr: { external: RUNTIME_EXTERNALS },
});
