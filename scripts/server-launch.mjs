/**
 * THE PACKAGED SERVER ENTRY.
 *
 * adapter-node derives url.origin from the Host header and PROTOCOL_HEADER,
 * falling back to `https` when that header is absent. The desktop server is
 * plain HTTP, so SvelteKit's CSRF check would reject every same-origin multipart
 * POST (the notes importer) as cross-site. Stamping the protocol header to
 * `http` before the adapter is imported makes url.origin match the browser's
 * Origin header. CSRF stays ENABLED.
 *
 * Env (the desktop shell's contract): PORT, HOSTNAME, LH_DATA_DIR, LH_AUTH_FILE.
 * ORIGIN is deliberately left unset so the per-request Host is the origin; a
 * real proxy deployment can still pin ORIGIN and win.
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME ?? process.env.HOST ?? "127.0.0.1";
const loopback = hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";

// Must precede ./handler.js: env.js/handler.js freeze their env reads at import.
// The header name must be the one stamped below, or get_origin() reads nothing.
// Only the protocol is stamped; the host stays the request's own Host header,
// so a client-supplied x-forwarded-host can never pick the CSRF origin.
process.env.PROTOCOL_HEADER = "x-forwarded-proto";
// Preserve uncapped file imports instead of adapter-node's 512KiB default.
process.env.BODY_SIZE_LIMIT ??= "Infinity";
// The bundle's import.meta.url points inside server/chunks; the read-only
// prompt assets live at the payload root (copied there by build-server.mjs).
process.env.LH_ROOT ??= path.dirname(fileURLToPath(import.meta.url));

if (!loopback) {
	console.warn(`[learnharness] binding ${hostname}, not loopback — this server has no request authentication`);
}

const { handler } = await import("./handler.js");

const server = http.createServer((req, res) => {
	// Unconditional (never client-supplied) so the origin can't be spoofed.
	req.headers["x-forwarded-proto"] = "http";
	handler(req, res);
});

server.listen(port, hostname, () => {
	console.log(`[learnharness] listening on http://${hostname}:${port}`);
});
