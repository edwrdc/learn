
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-endpoint-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
process.env.OPENROUTER_API_KEY ??= "test-key-openrouter-custom-endpoint";

const {
	customEndpointKeyPresent,
	customEndpointState,
	discoverCustomEndpointModels,
	removeCustomEndpoint,
	saveCustomEndpoint,
	syncCustomEndpointProvider,
} = await import("../src/server/custom-endpoint.ts");
const { modelCatalog, validateModelsSettings } = await import("../src/server/model-catalog.ts");
const { keyStatuses } = await import("../src/server/keys.ts");
const { setCustomEndpointProvider, piEngineForSpec, piModels } = await import("../src/agent/models.ts");
const { stores } = await import("../src/server/stores.ts");
const { settingsStore } = stores;
const { chatStore } = stores;
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { resolveRoleSpec } = await import("../src/core/settings-resolution.ts");

const KEY = "test-custom-endpoint-key-123456";
const KEY_B = "test-custom-endpoint-key-B-123456";
const MODEL_ID = "deepseek-flash";

interface SeenRequest {
	method: string;
	url: string;
	authorization: string | undefined;
	body: string;
}

let server: http.Server;
let targetServer: http.Server;
let base = "";
let targetBase = "";
const seen: SeenRequest[] = [];
const targetSeen: string[] = [];

function sse(res: http.ServerResponse, text: string) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const item = {
		id: "msg_1",
		type: "message",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	send("response.created", { type: "response.created", response: { id: "resp_1", object: "response", status: "in_progress" } });
	send("response.output_item.added", {
		type: "response.output_item.added",
		output_index: 0,
		item: { id: "msg_1", type: "message", role: "assistant", content: [] },
	});
	send("response.output_text.delta", {
		type: "response.output_text.delta",
		output_index: 0,
		item_id: "msg_1",
		content_index: 0,
		delta: text,
	});
	send("response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
	send("response.completed", {
		type: "response.completed",
		response: {
			id: "resp_1",
			object: "response",
			status: "completed",
			output: [item],
			usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } },
		},
	});
	res.end();
}

async function readBody(req: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

before(async () => {
	server = http.createServer(async (req, res) => {
		const url = req.url ?? "";
		const body = await readBody(req);
		seen.push({ method: req.method ?? "", url, authorization: req.headers.authorization, body });
		if (req.method === "GET" && (url === "/v1/models" || url === "/alt/v1/models")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: MODEL_ID, name: "DeepSeek Flash" }, { id: "manual-only", name: "Manual Only" }] }));
			return;
		}
		if (req.method === "GET" && url === "/broken/v1/models") {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "nope" }));
			return;
		}
		if (req.method === "GET" && url === "/redirect/v1/models") {
			res.writeHead(302, { location: `${targetBase}/leaked` });
			res.end();
			return;
		}
		if (req.method === "POST" && url === "/redirect/v1/responses") {
			res.writeHead(302, { location: `${targetBase}/leaked-response` });
			res.end();
			return;
		}
		if (req.method === "POST" && (url === "/v1/responses" || url === "/alt/v1/responses")) {
			sse(res, "Hello from the custom endpoint");
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

	targetServer = http.createServer((req, res) => {
		targetSeen.push(req.url ?? "");
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => targetServer.listen(0, "127.0.0.1", resolve));
	targetBase = `http://127.0.0.1:${(targetServer.address() as { port: number }).port}`;
});

after(() => {
	server.close();
	targetServer.close();
	fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
	seen.length = 0;
	targetSeen.length = 0;
});

const model = {
	id: MODEL_ID,
	name: "DeepSeek Flash",
	contextWindow: 64_000,
	maxTokens: 8_192,
	reasoning: true,
	imageInput: true,
};

function saveLocal(extra: { displayName?: string; baseUrl?: string; models?: unknown[]; apiKey?: string } = {}) {
	return saveCustomEndpoint({
		displayName: extra.displayName ?? "Local endpoint",
		baseUrl: extra.baseUrl ?? `${base}/v1`,
		models: extra.models ?? [model],
		...(extra.apiKey !== undefined ? { apiKey: extra.apiKey } : {}),
	});
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	assert.fail(`timed out waiting for ${what}`);
}

describe("custom endpoint E2E", () => {
	it("setup → discovery → model selection → Responses stream → persisted catalog", async () => {
		const first = saveLocal({ models: [], apiKey: KEY });
		assert.ok(first.ok, first.ok ? "" : first.error);
		assert.equal(first.state.keyPresent, true);
		assert.deepEqual(first.state.endpoint?.models, []);

		const settingsText = fs.readFileSync(path.join(TMP, "settings.json"), "utf8");
		assert.ok(settingsText.includes("Local endpoint"));
		assert.ok(!settingsText.includes(KEY), "settings.json never holds the key");
		assert.ok(fs.readFileSync(path.join(TMP, "auth.json"), "utf8").includes(KEY), "auth.json is the secret store");
		assert.ok(!JSON.stringify(customEndpointState()).includes(KEY), "GET state never carries the key");
		assert.ok(!keyStatuses().some((s) => s.id.startsWith("LH_CUSTOM_ENDPOINT_API_KEY")));

		const discovery = await discoverCustomEndpointModels({ baseUrl: `${base}/v1` });
		assert.ok(discovery.ok, discovery.ok ? "" : discovery.error);
		assert.deepEqual(discovery.models, [
			{ id: MODEL_ID, name: "DeepSeek Flash" },
			{ id: "manual-only", name: "Manual Only" },
		]);
		assert.equal(seen.at(-1)?.authorization, `Bearer ${KEY}`);

		const saved = saveLocal();
		assert.ok(saved.ok, saved.ok ? "" : saved.error);
		assert.deepEqual(saved.state.endpoint, {
			displayName: "Local endpoint",
			baseUrl: `${base}/v1`,
			models: [model],
		});
		assert.equal(saved.state.keyPresent, true, "an omitted key on edit keeps the stored one");

		const catalog = modelCatalog();
		const entry = catalog.models.find((m) => m.provider === "custom-endpoint" && m.id === MODEL_ID);
		assert.ok(entry, "custom model federates into the picker");
		assert.equal(entry!.name, "DeepSeek Flash");
		assert.equal(entry!.cost, null, "custom prices are UNKNOWN, never fake zeros");
		assert.deepEqual(entry!.input, ["text", "image"]);
		assert.ok(entry!.supportedLevels.includes("high"), "reasoning support reaches the thinking picker");
		assert.equal(entry!.contextWindow, 64_000);
		assert.equal(entry!.maxTokens, 8_192);
		assert.equal(catalog.providers.find((p) => p.id === "custom-endpoint")?.keyPresent, true);
		assert.ok(
			catalog.models.some((m) => m.provider === "openrouter" && m.cost && typeof m.cost.input === "number"),
			"builtin providers keep their priced catalog",
		);
		const customPin = { model: { provider: "custom-endpoint", id: MODEL_ID } };
		assert.deepEqual(validateModelsSettings({ strong: customPin, cheap: customPin, vision: customPin }), { ok: true });
		const record = settingsStore.readSettings()!;
		const roleSpec = resolveRoleSpec("researcher", {
			...record,
			agent: { ...record.agent, models: { researcher: customPin } },
		});
		assert.ok(roleSpec);
		assert.equal(piEngineForSpec(roleSpec!).model.baseUrl, `${base}/v1`);

		setCustomEndpointProvider(null);
		const reloaded = modelCatalog();
		assert.ok(reloaded.models.some((m) => m.provider === "custom-endpoint" && m.id === MODEL_ID), "config reloads from disk");

		const engine = piEngineForSpec({ provider: "custom-endpoint", id: MODEL_ID, thinkingLevel: "off" });
		const events: string[] = [];
		for await (const event of engine.streamFn(
			engine.model,
			{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }] } as never,
			{},
		)) {
			events.push(event.type);
			if (event.type === "done") {
				const text = (event.message.content as Array<{ type: string; text?: string }>).find((b) => b.type === "text")?.text;
				assert.equal(text, "Hello from the custom endpoint");
			}
		}
		assert.ok(events.includes("done"));
		const responseCall = seen.find((s) => s.method === "POST" && s.url === "/v1/responses");
		assert.ok(responseCall, "the Responses endpoint was called");
		assert.equal(responseCall!.authorization, `Bearer ${KEY}`);
		assert.equal((JSON.parse(responseCall!.body) as { model: string }).model, MODEL_ID);
	});

	it("a real chat turn runs on the custom endpoint and persists the streamed reply", async () => {
		settingsStore.writeSettings({
			version: 1,
			graph: { enabled: false },
			...(customEndpointState().endpoint ? { customEndpoint: customEndpointState().endpoint! } : {}),
		});
		const chat = chatStore.createChat("Custom endpoint E2E");
		chatStore.saveSettings(chat.id, { model: { provider: "custom-endpoint", id: MODEL_ID } });

		seen.length = 0;
		const res = await handleChatInput(chat.id, { type: "text", text: "Hello endpoint" });
		assert.equal(res.status, 200, await res.clone().text());
		const handle = runningTurn(chat.id);
		if (handle) await new Response(handle.subscribe()).text();

		await waitFor(() => {
			const record = chatStore.getChat(chat.id);
			return Boolean(
				record?.messages.some(
					(m) =>
						m.role === "assistant" &&
						m.content.some((b) => b.type === "text" && b.text.includes("Hello from the custom endpoint")),
				),
			);
		}, "the persisted assistant reply");

		const responseCall = seen.find((s) => s.method === "POST" && s.url === "/v1/responses");
		assert.ok(responseCall, "the turn used the custom Responses endpoint");
		assert.equal((JSON.parse(responseCall!.body) as { model: string }).model, MODEL_ID);
		assert.equal(responseCall!.authorization, `Bearer ${KEY}`);
	});

	it("invalid URLs/metadata, failed discovery, and manual model fallback", async () => {
		removeCustomEndpoint();

		const noKey = saveLocal({ models: [], apiKey: undefined });
		assert.equal(noKey.ok, false);
		if (!noKey.ok) assert.match(noKey.error, /API key is required/);

		for (const badUrl of [
			"http://example.com/v1",
			"ftp://example.com/v1",
			"https://user:pass@example.com/v1",
			"https://example.com/v1?x=1",
		]) {
			const bad = saveLocal({ models: [], apiKey: KEY, baseUrl: badUrl });
			assert.equal(bad.ok, false, badUrl);
		}
		const badModel = saveLocal({
			models: [{ ...model, maxTokens: 100_000 }],
			apiKey: KEY,
		});
		assert.equal(badModel.ok, false);
		if (!badModel.ok) assert.match(badModel.error, /maxTokens must not exceed/);

		const broken = saveLocal({ models: [], apiKey: KEY, baseUrl: `${base}/broken/v1` });
		assert.ok(broken.ok, broken.ok ? "" : broken.error);
		const discovery = await discoverCustomEndpointModels({ baseUrl: `${base}/broken/v1` });
		assert.equal(discovery.ok, false);
		if (!discovery.ok) {
			assert.equal(discovery.status, 502);
			assert.match(discovery.error, /HTTP 500/);
			assert.ok(!discovery.error.includes(KEY), "errors never echo the key");
		}

		const manual = saveLocal({ baseUrl: `${base}/broken/v1`, models: [model] });
		assert.ok(manual.ok, manual.ok ? "" : manual.error);
		const entry = modelCatalog().models.find((m) => m.provider === "custom-endpoint" && m.id === MODEL_ID);
		assert.ok(entry, "manual model joins the picker without discovery");
		assert.equal(entry!.cost, null);
	});

	it("stored credentials never follow changed URLs or redirects", async () => {
		const saved = saveLocal({ models: [], apiKey: KEY });
		assert.ok(saved.ok, saved.ok ? "" : saved.error);

		targetSeen.length = 0;
		const repoint = saveLocal({ baseUrl: `${targetBase}/v1` });
		assert.equal(repoint.ok, false);
		if (!repoint.ok) assert.match(repoint.error, /again when changing the base URL/);
		assert.deepEqual(targetSeen, [], "the repointed URL was never contacted");
		const changed = await discoverCustomEndpointModels({ baseUrl: `${targetBase}/v1` });
		assert.equal(changed.ok, false);
		if (!changed.ok) {
			assert.equal(changed.status, 400);
			assert.match(changed.error, /new base URL/);
		}
		assert.deepEqual(targetSeen, [], "the changed URL was never contacted");

		const redirected = saveLocal({ baseUrl: `${base}/redirect/v1`, models: [model], apiKey: KEY });
		assert.ok(redirected.ok, redirected.ok ? "" : redirected.error);
		const discovery = await discoverCustomEndpointModels({ baseUrl: `${base}/redirect/v1` });
		assert.equal(discovery.ok, false);
		if (!discovery.ok) assert.match(discovery.error, /redirect/i);
		assert.deepEqual(targetSeen, [], "discovery did not follow the redirect");

		const engine = piEngineForSpec({ provider: "custom-endpoint", id: MODEL_ID, thinkingLevel: "off" });
		for await (const _event of engine.streamFn(
			engine.model,
			{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }] } as never,
			{},
		)) {
		}
		assert.deepEqual(targetSeen, [], "the stream did not follow the redirect");
	});

	it("edits apply to subsequent requests; a running engine keeps its own endpoint + key, even after removal", async () => {
		const a = saveLocal({ models: [model], apiKey: KEY });
		assert.ok(a.ok, a.ok ? "" : a.error);
		const engineA = piEngineForSpec({ provider: "custom-endpoint", id: MODEL_ID, thinkingLevel: "off" });
		const aBase = engineA.model.baseUrl;

		const b = saveLocal({ baseUrl: `${base}/alt/v1`, models: [model], apiKey: KEY_B });
		assert.ok(b.ok, b.ok ? "" : b.error);
		const engineB = piEngineForSpec({ provider: "custom-endpoint", id: MODEL_ID, thinkingLevel: "off" });
		assert.equal(engineA.model.baseUrl, aBase, "an already-built engine retains its endpoint config");
		assert.equal(engineB.model.baseUrl, `${base}/alt/v1`, "the next engine resolves the edited config");

		async function drain(engine: ReturnType<typeof piEngineForSpec>) {
			for await (const _event of engine.streamFn(
				engine.model,
				{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }] } as never,
				{},
			)) {
			}
		}

		seen.length = 0;
		await drain(engineA);
		await drain(engineA);
		await drain(engineB);
		assert.deepEqual(
			seen.filter((s) => s.method === "POST").map((s) => [s.url, s.authorization]),
			[
				["/v1/responses", `Bearer ${KEY}`],
				["/v1/responses", `Bearer ${KEY}`],
				["/alt/v1/responses", `Bearer ${KEY_B}`],
			],
		);

		removeCustomEndpoint();
		seen.length = 0;
		await drain(engineA);
		await drain(engineB);
		assert.deepEqual(
			seen.filter((s) => s.method === "POST").map((s) => [s.url, s.authorization]),
			[
				["/v1/responses", `Bearer ${KEY}`],
				["/alt/v1/responses", `Bearer ${KEY_B}`],
			],
		);
		assert.throws(() => piEngineForSpec({ provider: "custom-endpoint", id: MODEL_ID }), /catalog has no model/);
	});

	it("a failed settings write cannot bind a new key to the old URL", async () => {
		const aUrl = `${base}/v1`;
		const bUrl = `${base}/alt/v1`;
		const a = saveLocal({ baseUrl: aUrl, models: [model], apiKey: KEY });
		assert.ok(a.ok, a.ok ? "" : a.error);

		const originalWrite = settingsStore.writeSettings;
		settingsStore.writeSettings = () => {
			throw new Error("injected settings write failure");
		};
		try {
			assert.throws(
				() => saveCustomEndpoint({ displayName: "A2", baseUrl: aUrl, models: [model], apiKey: KEY_B }),
				/injected settings write failure/,
			);
			assert.throws(
				() => saveCustomEndpoint({ displayName: "B", baseUrl: bUrl, models: [model], apiKey: KEY_B }),
				/injected settings write failure/,
			);
		} finally {
			settingsStore.writeSettings = originalWrite;
		}

		const afterFailure = customEndpointState();
		assert.equal(afterFailure.endpoint?.baseUrl, aUrl);
		assert.equal(afterFailure.keyPresent, true);
		assert.equal(afterFailure.keySource, "file");

		const engineA = piEngineForSpec({ provider: "custom-endpoint", id: MODEL_ID, thinkingLevel: "off" });
		seen.length = 0;
		for await (const _event of engineA.streamFn(
			engineA.model,
			{ messages: [{ role: "user", content: [{ type: "text", text: "safe" }], timestamp: Date.now() }] } as never,
			{},
		)) {
		}
		assert.deepEqual(
			seen.filter((s) => s.method === "POST").map((s) => [s.url, s.authorization]),
			[["/v1/responses", `Bearer ${KEY}`]],
		);

		seen.length = 0;
		const failedDiscovery = await discoverCustomEndpointModels({ baseUrl: bUrl });
		assert.equal(failedDiscovery.ok, false);
		assert.deepEqual(seen, [], "the idle key was not sent to the new URL");

		const retried = saveCustomEndpoint({ displayName: "B", baseUrl: bUrl, models: [model], apiKey: KEY_B });
		assert.ok(retried.ok, retried.ok ? "" : retried.error);
		assert.equal(customEndpointState().endpoint?.baseUrl, bUrl);
		const authText = fs.readFileSync(path.join(TMP, "auth.json"), "utf8");
		assert.ok(authText.includes(KEY_B));
		assert.ok(!authText.includes(KEY), "the old origin's stored key is pruned after a committed edit");

		const record = settingsStore.readSettings()!;
		settingsStore.writeSettings({
			...record,
			customEndpoint: { displayName: "A", baseUrl: aUrl, models: [model] },
		});
		syncCustomEndpointProvider();
		assert.equal(customEndpointState().keyPresent, false, "no key exists for the new record's origin");
		seen.length = 0;
		const inconsistent = await discoverCustomEndpointModels({ baseUrl: aUrl });
		assert.equal(inconsistent.ok, false);
		assert.deepEqual(seen, [], "the unrelated origin's key was not sent");
	});

	it("removal deletes config + key, leaves chats intact, and saved pins fail clearly", async () => {
		const saved = saveLocal({ models: [model], apiKey: KEY });
		assert.ok(saved.ok, saved.ok ? "" : saved.error);
		const chat = chatStore.createChat("Removed endpoint session");
		chatStore.saveSettings(chat.id, { model: { provider: "custom-endpoint", id: MODEL_ID } });
		const before = chatStore.getChat(chat.id)!.messages;

		const removed = removeCustomEndpoint();
		assert.equal(removed.endpoint, null);
		assert.equal(removed.keyPresent, false);
		assert.ok(!fs.readFileSync(path.join(TMP, "auth.json"), "utf8").includes(KEY), "stored key is gone");
		assert.ok(!modelCatalog().models.some((m) => m.provider === "custom-endpoint"), "removed models leave the picker");
		assert.equal(customEndpointKeyPresent(), false);

		const record = chatStore.getChat(chat.id)!;
		assert.deepEqual(record.messages, before, "chats are not rewritten by endpoint removal");
		const res = await handleChatInput(chat.id, { type: "text", text: "still here?" });
		assert.equal(res.status, 503);
		const envelope = (await res.json()) as { code?: string; error?: string };
		assert.equal(envelope.code, "provider_key_missing");
		assert.match(envelope.error ?? "", /custom endpoint/);
		assert.deepEqual(chatStore.getChat(chat.id)!.messages, before, "the refused turn wrote nothing");
	});

});

describe("custom endpoint URL boundary (pure)", () => {
	it("accepts HTTPS anywhere and HTTP only on loopback", async () => {
		const { normalizeCustomEndpointBaseUrl } = await import("../src/core/custom-endpoint.ts");
		assert.equal(normalizeCustomEndpointBaseUrl("https://api.example.com/v1/").ok, true);
		assert.equal(normalizeCustomEndpointBaseUrl("http://localhost:8080/v1").ok, true);
		assert.equal(normalizeCustomEndpointBaseUrl("http://127.0.0.1:8080/v1").ok, true);
		assert.equal(normalizeCustomEndpointBaseUrl("http://[::1]:8080/v1").ok, true);
		assert.equal(normalizeCustomEndpointBaseUrl("http://example.com/v1").ok, false);
		const normalized = normalizeCustomEndpointBaseUrl("https://api.example.com/v1///");
		assert.ok(normalized.ok);
		assert.equal(normalized.value, "https://api.example.com/v1");
	});
});
