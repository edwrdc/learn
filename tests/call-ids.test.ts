import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claimToolCallId, collectToolCallIds } from "../src/server/pi/call-ids.ts";

/**
 * THE LACAN INCIDENT (owner-approved fix, 2026-10-04): DeepSeek (via
 * OpenRouter) returns tool-call ids that reset every response — a
 * one-call-per-turn session names EVERY call `call_0`. The durable
 * afterResponse hook (durable-registry.ts) remints colliding ids once, so
 * the client, the record, the dock, and the next turn's context agree.
 * The end-to-end remint is pinned in tests/chat-flow.test.ts; these pins
 * cover the two pure functions the hook is built from.
 */

const assistantMsg = (id: string, callIds: string[]): any => ({
	id,
	role: "assistant",
	content: callIds.map((cid) => ({ type: "toolCall", id: cid, name: "quiz", arguments: {} })),
});
const toolResultMsg = (callId: string): any => ({
	id: `r_${callId}`,
	role: "toolResult",
	toolCallId: callId,
	content: [],
	details: { kind: "quiz" },
});

describe("claimToolCallId", () => {
	it("unique ids pass through verbatim — the wire stays honest when the provider is", () => {
		assert.equal(claimToolCallId("toolu_abc", new Set(["call_9"])), "toolu_abc");
	});

	it("a colliding id mints `orig~2` and records the claim", () => {
		const seen = new Set(["call_0"]);
		assert.equal(claimToolCallId("call_0", seen), "call_0~2");
		assert.ok(seen.has("call_0~2"));
	});

	it("mint candidates skip ids already used (a provider that counts globally can't be ambushed)", () => {
		assert.equal(claimToolCallId("call_0", new Set(["call_0", "call_0~2"])), "call_0~3");
	});

	it("each call in a message claims once, so a parallel sibling keeps its distinct id", () => {
		const seen = new Set(["call_1"]);
		assert.equal(claimToolCallId("call_0", seen), "call_0");
		assert.equal(claimToolCallId("call_1", seen), "call_1~2");
	});

	it("a retried id in a later response gets the next mint, not the earlier one", () => {
		const seen = new Set<string>();
		assert.equal(claimToolCallId("call_0", seen), "call_0");
		assert.equal(claimToolCallId("call_0", seen), "call_0~2");
		assert.equal(claimToolCallId("call_0", seen), "call_0~3");
	});
});

describe("collectToolCallIds (the seen-set seed)", () => {
	it("gathers call ids and result ids from a record", () => {
		const ids = collectToolCallIds([
			{ id: "a", role: "user", content: "hi" },
			assistantMsg("m1", ["call_0", "toolu_x"]),
			toolResultMsg("call_0"),
			{ id: "m2", role: "assistant", content: [{ type: "text", text: "no calls" }] },
		]);
		assert.deepEqual(ids, ["call_0", "toolu_x", "call_0"]);
	});

	it("seeding a claim set with a legacy record's ids forces the next response to mint", () => {
		const seen = new Set(collectToolCallIds([assistantMsg("m1", ["call_0"]), toolResultMsg("call_0")]));
		assert.equal(claimToolCallId("call_0", seen), "call_0~2");
	});
});
