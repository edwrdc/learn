import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { Type } from "typebox";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	normalizeContext,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { APP_IDENTITY, piEngineForSpec, type PiEngine } from "../src/platform/engines.ts";
import { handleChatRequest } from "../src/session/turn.ts";
import "./support-durable.ts";
import { isTurnRunning } from "../src/session/turn-liveness.ts";
import { backgroundRun } from "../src/jobs/durable-run.ts";
import { chatStore } from "../src/session/store.ts";
import { closeChatRuntime } from "../src/session/durable.ts";
import type { AppTool } from "../src/tools/adapter.ts";
import metadata from "../package.json" with { type: "json" };

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const createdChats: string[] = [];
after(async () => {
	for (const id of createdChats) {
		await closeChatRuntime(id).catch(() => undefined);
		await chatStore.deleteChat(id).catch(() => undefined);
	}
});

function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000, what = "condition"): Promise<void> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const tick = async () => {
			if (await cond()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(() => void tick(), 25);
		};
		void tick();
	});
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

function recordingEngine(steps: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0]) {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	const requests: SimpleStreamOptions[] = [];
	const engine: PiEngine = {
		model: faux.getModel(),
		streamFn: (model, context, options) => {
			requests.push(options ?? {});
			return faux.streamSimple(model, context, options);
		},
	};
	return { engine, requests };
}

const again: AppTool = {
	name: "again",
	description: "Continue",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
};

// Whole-process replacement isolates native auth/profile discovery; fetch never
// delegates. No real credentials, .env, OAuth accounts, or model inference.
async function closed<T>(run: () => Promise<T>): Promise<T> {
	const env = process.env;
	const fetch = globalThis.fetch;
	process.env = { NODE_ENV: "test", HOME: "/nonexistent/session-identity", OPENROUTER_API_KEY: "dummy-router", OPENCODE_API_KEY: "dummy-go", OPENAI_API_KEY: "dummy-openai" };
	globalThis.fetch = async () => { throw new Error("CLOSED: unexpected fetch"); };
	try { return await run(); } finally { process.env = env; globalThis.fetch = fetch; }
}

describe("native app and conversation identity", { concurrency: false }, () => {
	it("shares one deeply frozen metadata-derived identity, without mutable conversation state", () => {
		assert.deepEqual(APP_IDENTITY, { userAgent: { custom: `learnharness/${metadata.version}` }, attribution: { name: metadata.name, url: metadata.homepage } });
		for (const value of [APP_IDENTITY, APP_IDENTITY.userAgent, APP_IDENTITY.attribution]) assert.ok(Object.isFrozen(value));
		assert.ok(!Object.hasOwn(APP_IDENTITY, "sessionId"));
	});

	it("durable foreground turns carry the app identity and the chat id as the provider session across tool rounds", async () => {
		const { engine, requests } = recordingEngine([
			fauxAssistantMessage([fauxToolCall("again", {}, { id: "call_0" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const chat = await chatStore.createChat("identity: foreground");
		createdChats.push(chat.id);
		await chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		const ack = await handleChatRequest(post(chat.id, { type: "text", text: "offline" }), { engine, tools: { again } });
		assert.equal(ack.status, 200, await ack.text());
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the turn settles");
		assert.equal(requests.length, 2, "the tool round made two requests");
		for (const options of requests) {
			assert.equal(options.sessionId, chat.id, "the public chat id IS the provider session id");
			assert.deepEqual(options.identity, APP_IDENTITY, "the app identity rides every request");
			assert.ok(options.signal instanceof AbortSignal);
			assert.equal(options.apiKey, undefined, "no key is pinned on the request");
		}
	});

	it("background runs own distinct provider sessions, never the chat's", async () => {
		const chat = await chatStore.createChat("identity: background");
		createdChats.push(chat.id);
		const ids = new Set<string>();
		for (const n of [1, 2, 3]) {
			const { engine, requests } = recordingEngine([
				fauxAssistantMessage([fauxToolCall("again", {}, { id: "call_0" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("done")]),
			]);
			let usage: { steps?: number } | undefined;
			const result = await backgroundRun({
				jobId: `job_identity_${n}_${Date.now()}`,
				chatId: chat.id,
				kind: "research",
				role: "researcher",
				engine,
				maxTurns: 3,
				systemPrompt: "offline",
				prompt: "offline",
				onUsage: (total) => {
					usage = total;
				},
			});
			assert.equal(requests.length, 2);
			assert.equal(usage?.steps, 2, "the folded usage reports both completed steps");
			const id = requests[0]!.sessionId;
			assert.match(id ?? "", /^[0-9a-f-]{36}$/, "a per-run native session id");
			assert.notEqual(id, chat.id, "the chat's session is not reused");
			assert.ok(!ids.has(id!), "each background invocation is its own conversation");
			ids.add(id!);
			for (const options of requests) {
				assert.equal(options.sessionId, id);
				assert.deepEqual(options.identity, APP_IDENTITY);
			}
			assert.equal(result.text, "done");
			assert.equal(result.steps.length, 2);
		}
	});

	for (const [provider, id, endpoint] of [
		["opencode-go", "claude-haiku-5-5", "/inference/go/v1/messages"],
		["opencode-go", "gemini-4-argon-contributor", "/inference/go/v1/models/gemini-4-argon-contributor:streamGenerateContent"],
		["opencode-go", "glm-5.3", "/inference/go/v1/chat/completions"],
		["opencode-go", "gpt-6-luna", "/inference/go/v1/responses"],
		["openrouter", "openrouter/free", "/api/v1/chat/completions"],
	] as const) {
		it(`complete native ${provider}/${id} foreground serialization carries app identity and exact sessions`, async () => closed(async () => {
			const engine = piEngineForSpec({ provider, id, thinkingLevel: "off" });
			const requests: Request[] = [];
			globalThis.fetch = async (input, init) => { const request = new Request(input, init); requests.push(request); await request.text(); return new Response('{"error":{"message":"closed fixture"}}', { status: 400, headers: { "content-type": "application/json" } }); };
			await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "offline", timestamp: 1 }] }), {
				sessionId: "chat_wire_exact",
				identity: APP_IDENTITY,
			}).result().catch(() => undefined);
			assert.equal(requests.length, 1);
			const request = requests[0]!;
			assert.equal(new URL(request.url).pathname, endpoint);
			assert.equal(request.headers.get("user-agent"), `learnharness/${metadata.version}`);
			if (provider === "opencode-go") {
				assert.equal(new URL(request.url).origin, "https://opencode.ai");
				assert.equal(request.headers.get("x-opencode-client"), metadata.name);
				assert.equal(request.headers.get("x-opencode-session"), "chat_wire_exact");
				assert.ok(!JSON.stringify(Object.fromEntries(request.headers)).includes("dummy-router"));
			} else {
				assert.equal(new URL(request.url).origin, "https://openrouter.ai");
				assert.equal(request.headers.get("x-openrouter-title"), metadata.name);
				assert.equal(request.headers.get("http-referer"), metadata.homepage);
				assert.equal(request.headers.get("x-session-id"), "chat_wire_exact");
			}
		}));
	}

	it("native OpenAI cache keys clamp to 64 characters while affinity retains exact session", async () => closed(async () => {
		const engine = piEngineForSpec({ provider: "openai", id: "gpt-4o-mini", thinkingLevel: "off" });
		const sessionId = "chat_" + "a".repeat(70);
		let body: Record<string, unknown> = {};
		let headers = new Headers();
		globalThis.fetch = async (input, init) => { const request = new Request(input, init); headers = request.headers; body = JSON.parse(await request.text()); return new Response("{}", { status: 400, headers: { "content-type": "application/json" } }); };
		await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "offline", timestamp: 1 }] }), {
			sessionId,
			identity: APP_IDENTITY,
		}).result().catch(() => undefined);
		assert.equal(body.prompt_cache_key, Array.from(sessionId).slice(0, 64).join(""));
		assert.equal(headers.get("session_id"), sessionId);
	}));

	it("native OpenAI cache-key clamp counts Unicode code points, not UTF-16 units", async () => closed(async () => {
		const engine = piEngineForSpec({ provider: "openai", id: "gpt-4o-mini", thinkingLevel: "off" });
		const sessionId = "chat_" + "😀".repeat(70);
		let payload: unknown;
		// HTTP affinity headers cannot encode emoji. Observe native payload
		// serialization before transport, then stop deliberately (no accounts).
		await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "offline", timestamp: 1 }] }), {
			sessionId,
			onPayload: (value) => { payload = value; throw new Error("CLOSED: payload captured"); },
		}).result();
		assert.equal((payload as { prompt_cache_key: string }).prompt_cache_key, Array.from(sessionId).slice(0, 64).join(""));
	}));

	it("native Codex serialization shares the 64-code-point clamp without an account or OAuth flow", async () => closed(async () => {
		const engine = piEngineForSpec({ provider: "openai-codex", id: "gpt-6-luna", thinkingLevel: "off" });
		// Synthetic, unsigned fixture token solely satisfies native local claim
		// decoding. Stop at payload capture: no account, OAuth, or fetch.
		const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "offline-fixture" } };
		const apiKey = `dummy.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.dummy`;
		for (const sessionId of ["chat_" + "a".repeat(70), "chat_" + "😀".repeat(70)]) {
			let payload: unknown;
			// The app intentionally has no Codex auth row: exercise the native
			// serializer directly rather than adding an OAuth configuration path.
			assert.equal(engine.model.api, "openai-codex-responses");
			const result = await streamCodex(engine.model as Model<"openai-codex-responses">, normalizeContext({ messages: [{ role: "user", content: "offline", timestamp: 1 }] }), {
				apiKey, sessionId, identity: APP_IDENTITY,
				onPayload: (value) => { payload = value; throw new Error("CLOSED: payload captured"); },
			}).result();
			assert.ok(payload, result.errorMessage);
			assert.equal((payload as { prompt_cache_key: string }).prompt_cache_key, Array.from(sessionId).slice(0, 64).join(""));
		}
	}));

	it("SDK native header precedence and cache-off behavior remain untouched", async () => closed(async () => {
		const engine = piEngineForSpec({ provider: "opencode-go", id: "gpt-6-luna", thinkingLevel: "off" });
		let headers = new Headers();
		let body: Record<string, unknown> = {};
		globalThis.fetch = async (input, init) => { const request = new Request(input, init); headers = request.headers; body = JSON.parse(await request.text()); return new Response("{}", { status: 400, headers: { "content-type": "application/json" } }); };
		await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "offline", timestamp: 1 }] }), { sessionId: "chat_cache_off", cacheRetention: "none", headers: { "user-agent": "explicit-sdk-override", "x-opencode-client": null } }).result().catch(() => undefined);
		assert.equal(headers.get("user-agent"), "explicit-sdk-override");
		assert.equal(headers.get("x-opencode-client"), null);
		// Native OpenCode routing identity remains even with cache retention off.
		assert.equal(headers.get("x-opencode-session"), "chat_cache_off");
		assert.equal(body.prompt_cache_key, undefined);
	}));

	it("completed malformed native JSON stays rejected despite app prepareArguments healing", async () => closed(async () => {
		const engine = piEngineForSpec({ provider: "openrouter", id: "openai/gpt-4o-mini", thinkingLevel: "off" });
		const malformed = '{"value":';
		let calls = 0;
		globalThis.fetch = async () => {
			calls++;
			if (calls === 1) {
				return new Response(`data: ${JSON.stringify({ id: "offline", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_bad", type: "function", function: { name: "check", arguments: malformed } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
			}
			return new Response(`data: ${JSON.stringify({ id: "offline", choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		};
		let executed = 0;
		let prepared = 0;
		const tools = { check: { name: "check", label: "check", description: "check", parameters: Type.Object({ value: Type.Optional(Type.String()) }), prepareArguments: (args: unknown) => { prepared++; return args as never; }, execute: async () => { executed++; return { content: [], details: {} }; } } };
		const chat = await chatStore.createChat("identity: malformed arguments");
		createdChats.push(chat.id);
		await chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "openai/gpt-4o-mini" } });
		const ack = await handleChatRequest(post(chat.id, { type: "text", text: "offline" }), { engine, tools });
		assert.equal(ack.status, 200, await ack.text());
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the turn settles");
		const record = (await chatStore.getChat(chat.id))!;
		const assistant = record.messages.find((m) => m.role === "assistant");
		assert.ok(assistant?.role === "assistant");
		const call = assistant.content.find((c) => c.type === "toolCall");
		assert.ok(call?.type === "toolCall" && call.argumentsError);
		assert.equal(executed, 0);
		assert.equal(prepared, 1, "SDK prepares arguments but preserves argumentsError for native validation");
		assert.ok(record.messages.some((m) => m.role === "toolResult" && m.isError));
	}));
});
