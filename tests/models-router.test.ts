/**
 * The per-conversation Models router (src/agent/models.ts routedModels):
 *
 *  - foreground and background conversations sharing one Harness must each
 *    stream through the engine captured for their own provider session id,
 *    including two runs of the same catalog model with different thinking /
 *    endpoint snapshots;
 *  - the raw provider recorder rides pi-ai's onProviderStreamEvent option, so
 *    it sees the adapter-owned payload BEFORE normalization (a local HTTP
 *    Responses SSE is the real adapter here).
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	type AssistantMessageEvent,
	type Model,
	type Api,
} from "@earendil-works/pi-ai";
import {
	APP_IDENTITY,
	bindRunEngine,
	piEngineForSpec,
	routedModels,
	setCustomEndpointProvider,
	type PiEngine,
} from "../src/agent/models.ts";
import { CUSTOM_ENDPOINT_PROVIDER_ID } from "../src/core/custom-endpoint.ts";

const KEY = "test-models-router-key-123456";
const MODEL_ID = "router-model";

function fauxEngine(text: string, steps = 1): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(Array.from({ length: steps }, () => fauxAssistantMessage([fauxText(text)])) as never);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function userContext(text: string) {
	return { messages: [{ role: "user" as const, content: text, timestamp: 1 }] };
}

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

let server: http.Server;
let base = "";
let requests = 0;

before(async () => {
	server = http.createServer((req, res) => {
		if (req.method === "POST" && req.url === "/v1/responses") {
			requests++;
			sse(res, "Hello from the routed endpoint");
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
	server.close();
});

describe("the per-session Models router", () => {
	it("keeps two conversations on the same catalog model on their own captured engines", async () => {
		const first = fauxEngine("engine one");
		const second = fauxEngine("engine two", 2);
		assert.equal(first.model.provider, second.model.provider, "same catalog provider");
		assert.equal(first.model.id, second.model.id, "same catalog model id");

		bindRunEngine("session-foreground", first);
		bindRunEngine("session-child", second);

		const models = routedModels();
		// The harness resolves the model ref through getModel: a bound engine's
		// captured model object wins, so limits/endpoint metadata are pinned.
		assert.equal(models.getModel(first.model.provider, first.model.id), first.model);

		// Interleave: both requests are open before either result is read.
		const model = first.model;
		const one = models.streamSimple(model, userContext("hello") as never, { sessionId: "session-foreground" });
		const two = models.streamSimple(model, userContext("hello") as never, { sessionId: "session-child" });
		const firstText = ((await one.result()) as { content: Array<{ text?: string }> }).content[0]?.text;
		const secondText = ((await two.result()) as { content: Array<{ text?: string }> }).content[0]?.text;
		assert.equal(firstText, "engine one");
		assert.equal(secondText, "engine two");

		// Rebinding one session must never redirect the other.
		const swapped = fauxEngine("engine one swapped");
		bindRunEngine("session-foreground", swapped);
		const again = models.streamSimple(model, userContext("hello") as never, { sessionId: "session-child" });
		assert.equal(((await again.result()) as { content: Array<{ text?: string }> }).content[0]?.text, "engine two");
	});

	it("streams a real OpenAI Responses SSE through the bound engine and records RAW provider events", async () => {
		setCustomEndpointProvider(
			{
				displayName: "Router endpoint",
				baseUrl: `${base}/v1`,
				models: [
					{ id: MODEL_ID, name: MODEL_ID, contextWindow: 8192, maxTokens: 1024, reasoning: false, imageInput: false },
				],
			},
			KEY,
		);
		const engine = piEngineForSpec({ provider: CUSTOM_ENDPOINT_PROVIDER_ID, id: MODEL_ID });

		const raw: unknown[] = [];
		const normalized: string[] = [];
		bindRunEngine("session-sse", engine, (data) => raw.push(data));

		const models = routedModels();
		const model = engine.model as Model<Api>;
		const stream = models.streamSimple(model, userContext("hi") as never, { sessionId: "session-sse" });
		for await (const event of stream as AsyncIterable<AssistantMessageEvent>) normalized.push(event.type);
		const message = (await stream.result()) as { content: Array<{ text?: string }> };
		assert.equal(message.content[0]?.text, "Hello from the routed endpoint");
		assert.equal(requests, 1, "one provider request through the bound custom endpoint");

		const delta = raw.find((event) => (event as { type?: string }).type === "response.output_text.delta") as
			| { type: string; item_id?: string; content_index?: number; delta?: string }
			| undefined;
		assert.ok(delta, "the raw pre-normalization event was observed");
		assert.equal(delta.item_id, "msg_1", "the raw payload keeps its adapter-owned fields");
		assert.equal(delta.delta, "Hello from the routed endpoint");
		assert.equal(
			normalized.some((type) => type.includes("response.")),
			false,
			"normalized events are a different shape entirely",
		);
		assert.ok(normalized.includes("text_delta"), "the normalized stream still reaches the consumer");
		assert.equal(APP_IDENTITY.attribution.name, "learnharness", "provider identity is the app's");
		setCustomEndpointProvider(null);
	});
});
