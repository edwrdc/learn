import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
export default {
	preprocess: vitePreprocess(),
	kit: {
		// The repo's existing static-asset root (fonts, worklets) — SvelteKit's
		// default is static/, but every current URL is rooted at /fonts, so the
		// public/ path and its URLs are preserved verbatim.
		files: { assets: "public" },
		alias: { "@": "." },
		// NOT build/ — that is electron-builder's resources dir (icons, entitlements).
		// The payload gate, the smoke scripts and electron-builder.yml all name
		// dist-server/standalone explicitly.
		adapter: adapter({ out: "dist-server" }),
	},
};
