/**
 * Static render harness for the Svelte render layer (node:test). Vite's SSR
 * module loader compiles .svelte on the fly with the app's own config and
 * aliases, so tests exercise the exact components the browser ships.
 */
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";

let serverPromise: Promise<ViteDevServer> | null = null;

async function server(): Promise<ViteDevServer> {
	serverPromise ??= createServer({
		configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
		server: { middlewareMode: true, hmr: false },
		appType: "custom",
		logLevel: "error",
		// The config's sourceEnv hook would otherwise ingest a developer's
		// .env.local into this test process; no dotenv here, no real keys.
		envDir: false,
	});
	return serverPromise;
}

export interface StaticRender {
	head: string;
	body: string;
}

export async function renderSvelte(component: string, props: Record<string, unknown> = {}): Promise<StaticRender> {
	const vite = await server();
	const loaded = (await vite.ssrLoadModule(component)) as { default: unknown };
	const svelteServer = (await vite.ssrLoadModule("svelte/server")) as {
		render: (component: unknown, options: { props: Record<string, unknown> }) => StaticRender;
	};
	return svelteServer.render(loaded.default, { props });
}

/** Load a Svelte module's named exports (helpers in <script module>) through
 *  the same Vite SSR graph the components use. */
export async function loadSvelteModule(path: string): Promise<Record<string, unknown>> {
	const vite = await server();
	return (await vite.ssrLoadModule(path)) as Record<string, unknown>;
}

export async function closeSvelteSsr(): Promise<void> {
	if (!serverPromise) return;
	const vite = await serverPromise;
	await vite.close();
	serverPromise = null;
}
