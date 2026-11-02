/** Client-side stand-ins for the server-only crypto helpers in the shared
 *  core barrel (coverage.ts createHash, graph.ts randomBytes). The browser
 *  never calls them; the alias exists so the barrel bundles without a
 *  node:crypto polyfill. The SSR build keeps the real module. */
export function createHash(_algorithm: string): never {
	throw new Error("node:crypto is server-only");
}

export function randomBytes(_size: number): never {
	throw new Error("node:crypto is server-only");
}
