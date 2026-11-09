import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { getStatus, isolatedPayload, request, smokeOptions, startPayloadServer } from "./smoke-harness.mjs";

const { source: SOURCE, electron: ELECTRON_MODE, runtime: RUNTIME } = smokeOptions("smoke-carrier");

async function readStream(url, until, timeoutMs = 10_000) {
	const controller = new AbortController();
	setTimeout(() => controller.abort(new Error(`no frame within ${timeoutMs}ms`)), timeoutMs).unref();
	let res;
	try {
		res = await fetch(url, { headers: { accept: "text/event-stream" }, signal: controller.signal });
	} catch (error) {
		throw new Error(`stream ${url} did not open within ${timeoutMs}ms`, { cause: error });
	}
	assert.equal(res.status, 200, `GET ${url} → ${res.status}`);
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let body = "";
	try {
		while (!until(body)) {
			const { value, done } = await reader.read();
			if (done) break;
			body += decoder.decode(value, { stream: true });
		}
	} catch (error) {
		throw new Error(`stream ${url} failed within ${timeoutMs}ms; got:\n${body}`, { cause: error });
	} finally {
		await reader.cancel().catch(() => {});
	}
	assert.ok(until(body), `stream ${url} ended early; got:\n${body}`);
	return { body, headers: res.headers };
}

const origin = (base) => new URL(base).origin;

function multipart(files) {
	const form = new FormData();
	for (const [name, content] of files) form.append("files", new File([content], name, { type: "text/markdown" }));
	return form;
}

async function main() {
	const standalone = isolatedPayload(SOURCE, "lh-carrier-payload-");
	const server = await startPayloadServer({ standalone, runtime: RUNTIME, electron: ELECTRON_MODE, env: { PROTOCOL_HEADER: "x-forwarded-protocol" } });
	const base = server.url;
	const fail = (message) => {
		console.error(`[smoke-carrier] FAIL: ${message}`);
		const tail = server.logTail(25);
		if (tail.length > 0) console.error(`--- server log tail ---\n    ${tail.join("\n    ")}`);
	};

	try {
		console.log(`[smoke-carrier] runtime: ${ELECTRON_MODE ? "Electron bundled Node" : `host Node ${process.versions.node}`} (${RUNTIME})`);
		console.log(`[smoke-carrier] payload: ${standalone} (outside the worktree; no ancestor node_modules)`);

		const homeRes = await request(base + "/");
		assert.equal(homeRes.status, 200);
		const homeHtml = await homeRes.text();
		assert.match(homeHtml, /^<!doctype html>/i, "the home route renders a document server-side");
		assert.ok(!homeHtml.includes("%sveltekit."), "every %sveltekit.* placeholder is filled");
		assert.match(homeHtml, /_app\/immutable\/assets\//, "the served document references the packaged client bundle");
		console.log("[smoke-carrier] SSR: / renders a complete document with packaged assets");

		const created = await request(base + "/api/chats", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "carrier SSR probe" }),
		});
		assert.equal(created.status, 200);
		const { id: chatId } = await created.json();
		assert.equal(typeof chatId, "string");

		const missing = await request(base + "/chat/nope-not-a-chat");
		assert.equal(missing.status, 404, "the chat load reads the store: unknown id → 404");
		console.log("[smoke-carrier] routing: unknown chat → 404 (the load reads the store server-side)");

		const draft = await request(base + "/chat/new");
		assert.equal(draft.status, 200, "/chat/new is the static draft route");
		const practice = await request(base + "/chat/new?mode=practice");
		assert.equal(practice.status, 200);
		const settings = await request(base + "/settings", { redirect: "manual" });
		assert.equal(settings.status, 307);
		assert.equal(new URL(settings.headers.get("location"), base).pathname, "/chat/new");
		console.log("[smoke-carrier] routing: /chat/new beats /chat/[id]; /settings → 307 /chat/new");

		const sameOrigin = await request(base + "/api/graph/import", {
			method: "POST",
			headers: { origin: origin(base) },
			body: multipart([["notes.md", "carrier import probe"]]),
		});
		assert.equal(sameOrigin.status, 200, "same-origin multipart must pass SvelteKit's CSRF check");
		const importer = await sameOrigin.json();
		assert.equal(importer.results?.[0]?.code, "models_not_configured", "the importer ran (no models configured in throwaway data)");

		for (const hostile of ["http://evil.example", "null", "not-a-url"]) {
			const refused = await request(base + "/api/graph/import", {
				method: "POST",
				headers: { origin: hostile },
				body: multipart([["notes.md", "carrier import probe"]]),
			});
			assert.equal(refused.status, 403, `Origin: ${hostile} must stay forbidden`);
			assert.match(await refused.text(), /Cross-site POST form submissions are forbidden/);
		}

		const bigFile = "x".repeat(2 * 1024 * 1024);
		const oversized = await request(
			base + "/api/graph/import",
			{
				method: "POST",
				headers: { origin: origin(base) },
				body: multipart([["big.md", bigFile]]),
			},
			30_000,
		);
		assert.equal(oversized.status, 200, "a 2MB import must not hit adapter-node's 512K default");
		console.log("[smoke-carrier] CSRF: same-origin 200, hostile/malformed/null Origin 403, inherited protocol header overridden; 2MB body accepted");

		for (const route of ["/api/graph", "/api/models", "/api/settings", "/api/settings/prompts", "/api/activity", "/api/keys"]) {
			const status = await getStatus(base + route);
			assert.equal(status, 200, `GET ${route} → ${status}`);
		}
		const prompts = await (await request(base + "/api/settings/prompts")).json();
		const promptBase = prompts.teacher?.find((segment) => segment.path === "system-prompt.md");
		const teachingSegment = prompts.teacher?.find((segment) => segment.path === "teacher/20-teaching.md");
		assert.ok(promptBase && promptBase.sourceText.length > 100, "the packaged system prompt was read from the payload root (LH_ROOT)");
		assert.ok(teachingSegment && teachingSegment.sourceText.length > 100, "packaged prompt fragments were read from disk");
		assert.ok(prompts.teacher.every((segment) => segment.sourceText.length > 0), "no segment silently reads empty");

		const segmentWrite = await request(base + "/api/settings/prompts/teacher%2F20-teaching.md", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "carrier override" }),
		});
		assert.equal(segmentWrite.status, 200, "a decoded mirror-layout segment path writes");
		assert.equal((await segmentWrite.json()).path, "teacher/20-teaching.md");
		const traversal = await request(base + "/api/settings/prompts/..%2F..%2Fetc%2Fpasswd", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "nope" }),
		});
		assert.equal(traversal.status, 400, "traversal is refused by the store validator");
		await request(base + "/api/settings/prompts/teacher%2F20-teaching.md", { method: "DELETE" });
		console.log("[smoke-carrier] API: graph/models/settings/prompts/activity/keys 200; prompts read from LH_ROOT; catch-all write + traversal refusal");

		const eventsUrl = base + "/api/events";
		const eventsPromise = readStream(eventsUrl, (body) => body.includes("event: chats-changed"));
		await new Promise((resolve) => setTimeout(resolve, 250));
		const ping = await request(base + "/api/chats", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "carrier events probe" }),
		});
		assert.equal(ping.status, 200);
		const events = await eventsPromise;
		assert.equal(events.headers.get("content-type"), "text/event-stream");
		assert.equal(events.headers.get("cache-control"), "no-cache, no-transform");
		assert.equal(events.headers.get("x-accel-buffering"), "no");
		assert.match(events.body, /event: chats-changed\ndata: \{\}/, "event payloads stay fact-only JSON");
		console.log("[smoke-carrier] SSE /api/events: framed chats-changed + no-buffer headers");

		const silent = readStream(eventsUrl, (body) => body.includes("event: never-sent"), 1_500);
		await new Promise((resolve) => setTimeout(resolve, 250));
		await request(base + "/api/chats", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "deadline probe" }),
		});
		await assert.rejects(silent, /within 1500ms/, "a stream that stops producing the expected frame must abort at the deadline");
		console.log("[smoke-carrier] SSE deadline: an open stream without the expected frame aborts in 1.5s instead of hanging the job");

		const turn = await (await request(base + `/api/chats/${chatId}/stream`, {}, 10_000)).text();
		assert.match(turn, /"type":"turn-settled"/);
		assert.match(turn, /\[DONE\]/);
		console.log("[smoke-carrier] SSE /api/chats/[id]/stream: settled turn sends turn-settled + [DONE]");

		const controller = new AbortController();
		const doomed = await request(eventsUrl, { signal: controller.signal }, 10_000);
		const reader = doomed.body.getReader();
		await Promise.race([reader.read(), new Promise((resolve) => setTimeout(resolve, 1_000))]);
		controller.abort();
		await reader.cancel().catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(await getStatus(base + "/api/graph"), 200, "server healthy after a stream disconnect");
		const afterDisconnect = await request(base + "/api/chats", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "after disconnect" }),
		});
		assert.equal(afterDisconnect.status, 200, "the event bus still works after a subscriber left");
		const resubscribedPromise = readStream(eventsUrl, (body) => body.includes("event: chats-changed"));
		const reemit = await request(base + "/api/chats", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "resubscribed" }),
		});
		assert.equal(reemit.status, 200);
		const resubscribed = await resubscribedPromise;
		assert.match(resubscribed.body, /event: chats-changed/);
		console.log("[smoke-carrier] SSE: disconnect closes only the subscriber; server + bus + reattach survive");

		const abort = await request(base + "/api/activity/abort", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "turn", id: chatId }),
		});
		assert.equal(abort.status, 409, "nothing runs in the throwaway data dir; abort is honest");
		console.log("[smoke-carrier] abort route: 409 with nothing in flight (explicit, not connection-owned)");

		const serverDir = path.join(standalone, "server");
		const chunks = fs
			.readdirSync(serverDir, { recursive: true })
			.filter((file) => typeof file === "string" && file.endsWith(".js"))
			.filter((file) => fs.statSync(path.join(serverDir, file)).isFile());
		const pdfChunk = chunks.find((file) => fs.readFileSync(path.join(serverDir, file), "utf8").includes('"standard_fonts"'));
		assert.ok(pdfChunk, "the bundled pdf-ops module is present");
		// Mirrors the app: Node's lookup from the bundled chunk, not a fixed walk.
		const pdfManifest = createRequire(path.join(serverDir, pdfChunk)).resolve("pdfjs-dist/package.json");
		const fontsDir = path.join(path.dirname(pdfManifest), "standard_fonts");
		assert.ok(fontsDir.startsWith(standalone + path.sep), "standard_fonts resolves inside the payload");
		assert.ok(fs.existsSync(path.join(fontsDir, "FoxitFixed.pfb")), "the packaged PDF standard fonts are present");
		for (const native of ["@napi-rs/canvas", "@resvg/resvg-js"]) {
			assert.ok(fs.existsSync(path.join(standalone, "node_modules", native, "package.json")), `${native} ships in the payload`);
		}
		console.log("[smoke-carrier] native: payload carries pdfjs fonts, @napi-rs/canvas and @resvg/resvg-js");

		const font = await request(base + "/fonts/cmunbx.ttf");
		assert.equal(font.status, 200, "public/ assets are served from the payload");
		assert.match(font.headers.get("content-type") ?? "", /font/);
		await font.arrayBuffer();
		console.log("[smoke-carrier] static: /fonts/* served from the packaged client assets");

		const chatRes = await request(base + `/chat/${chatId}?prompt=hello`);
		assert.equal(chatRes.status, 200, "the shipped chat page renders server-side");
		assert.match(await chatRes.text(), /^<!doctype html>/i, "the chat page renders a full document server-side");
		console.log("[smoke-carrier] SSR: /chat/[id] renders the shipped UI for a stored chat");

		console.log("[smoke-carrier] carrier gate passed — isolated payload, SSR/routing, CSRF, body limit, SSE and assets");
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	} finally {
		await server.stop();
	}
}

main();
