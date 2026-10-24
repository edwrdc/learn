
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import http from "node:http";
import { after, before, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-env-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
delete process.env.LH_IGNORE_ENV_KEYS;
const ENV_KEY = "env-owned-custom-key-123456";
process.env.LH_CUSTOM_ENDPOINT_API_KEY = ENV_KEY;

const {
	customEndpointState,
	discoverCustomEndpointModels,
	removeCustomEndpoint,
	saveCustomEndpoint,
} = await import("../src/server/custom-endpoint.ts");
const { piEngineForSpec } = await import("../src/agent/models.ts");

const MODEL_ID = "deepseek-flash";
const model = {
	id: MODEL_ID,
	name: "DeepSeek Flash",
	contextWindow: 64_000,
	maxTokens: 8_192,
	reasoning: true,
	imageInput: false,
};

interface Seen {
	url: string;
	authorization: string | undefined;
}
const seen: Seen[] = [];
let server: http.Server;
let base = "";

function sse(res: http.ServerResponse, text: string) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const item = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
	const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	send("response.created", { type: "response.created", response: { id: "resp_1", object: "response", status: "in_progress" } });
	send("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } });
	send("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: text });
	send("response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
	send("response.completed", {
		type: "response.completed",
		response: {
			id: "resp_1",
			object: "response",
			status: "completed",
			output: [item],
			usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6, input_tokens_details: { cached_tokens: 0 } },
		},
	});
	res.end();
}

before(async () => {
	server = http.createServer((req, res) => {
		const url = req.url ?? "";
		seen.push({ url, authorization: req.headers.authorization });
		if (req.method === "GET" && url.endsWith("/models")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: MODEL_ID, name: "DeepSeek Flash" }] }));
			return;
		}
		if (req.method === "POST" && url.endsWith("/responses")) {
			sse(res, "Env key reply");
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
	server.close();
	delete process.env.LH_CUSTOM_ENDPOINT_API_KEY;
	fs.rmSync(TMP, { recursive: true, force: true });
});

async function drain(engine: ReturnType<typeof piEngineForSpec>) {
	for await (const _event of engine.streamFn(
		engine.model,
		{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }] } as never,
		{},
	)) {
	}
}

describe("environment-owned custom endpoint key", () => {
	it("is origin-bound and never silently replaced by a pasted key", async () => {
		const aUrl = `${base}/a`;
		const bUrl = `${base}/b`;

		const a = saveCustomEndpoint({ displayName: "A", baseUrl: aUrl, models: [model] });
		assert.ok(a.ok, a.ok ? "" : a.error);
		assert.equal(a.state.keyPresent, true);
		assert.equal(a.state.keySource, "env");

		const pasted = saveCustomEndpoint({ displayName: "A", baseUrl: aUrl, models: [model], apiKey: "pasted-key-B-123456" });
		assert.equal(pasted.ok, false);
		if (!pasted.ok) assert.match(pasted.error, /environment.*owns this key/);

		const rebind = saveCustomEndpoint({ displayName: "B", baseUrl: bUrl, models: [model] });
		assert.equal(rebind.ok, false);
		if (!rebind.ok) assert.match(rebind.error, /unset it before changing the base URL/);

		seen.length = 0;
		const pastedDiscovery = await discoverCustomEndpointModels({ baseUrl: bUrl, apiKey: "pasted-key-B-123456" });
		assert.equal(pastedDiscovery.ok, false);
		const noKeyDiscovery = await discoverCustomEndpointModels({ baseUrl: bUrl });
		assert.equal(noKeyDiscovery.ok, false);
		assert.equal(seen.length, 0, "no credential was sent to the refused origin");

		const discovery = await discoverCustomEndpointModels({ baseUrl: aUrl });
		assert.ok(discovery.ok, discovery.ok ? "" : discovery.error);
		assert.equal(seen.at(-1)?.authorization, `Bearer ${ENV_KEY}`);

		const engine = piEngineForSpec({ provider: "custom-endpoint", id: MODEL_ID, thinkingLevel: "off" });
		seen.length = 0;
		await drain(engine);
		assert.deepEqual(seen, [{ url: "/a/responses", authorization: `Bearer ${ENV_KEY}` }]);

		const edited = saveCustomEndpoint({ displayName: "A renamed", baseUrl: aUrl, models: [model] });
		assert.ok(edited.ok, edited.ok ? "" : edited.error);
		assert.equal(edited.state.keySource, "env");

		const removed = removeCustomEndpoint();
		assert.equal(removed.endpoint, null);
		assert.equal(removed.keyPresent, false);
		assert.equal(removed.keySource, "none");
		seen.length = 0;
		await drain(engine);
		assert.deepEqual(seen, [{ url: "/a/responses", authorization: `Bearer ${ENV_KEY}` }]);
		assert.throws(() => piEngineForSpec({ provider: "custom-endpoint", id: MODEL_ID }), /catalog has no model/);
	});
});
