import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { persistInverted } from "../src/lib/artifacts/artifact-ui.ts";

type Call = { url: string; init: RequestInit | undefined };

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		return await handler(url, init);
	}) as typeof fetch;
	return calls;
}

describe("persistInverted", () => {
	it("posts the toggle envelope for a card with both ids", async () => {
		const original = globalThis.fetch;
		try {
			const calls = stubFetch(async () => new Response("{}", { status: 200 }));
			persistInverted("chat_1", "msg_1", true);
			assert.equal(calls.length, 1);
			assert.equal(calls[0]?.url, "/api/chats/chat_1/artifact-ui");
			assert.equal(calls[0]?.init?.method, "POST");
			assert.deepEqual(calls[0]?.init?.headers, { "Content-Type": "application/json" });
			assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
				input: { messageId: "msg_1", inverted: true },
			});
		} finally {
			globalThis.fetch = original;
		}
	});

	it("sends nothing when the chat or message id is missing", async () => {
		const original = globalThis.fetch;
		try {
			const calls = stubFetch(async () => new Response("{}", { status: 200 }));
			persistInverted(undefined, "msg_1", true);
			persistInverted("chat_1", undefined, true);
			persistInverted(undefined, undefined, false);
			assert.equal(calls.length, 0);
		} finally {
			globalThis.fetch = original;
		}
	});

	it("swallows a rejected fetch", async () => {
		const original = globalThis.fetch;
		try {
			const calls = stubFetch(async () => {
				throw new Error("offline");
			});
			assert.doesNotThrow(() => persistInverted("chat_1", "msg_1", false));
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.equal(calls.length, 1);
		} finally {
			globalThis.fetch = original;
		}
	});
});
