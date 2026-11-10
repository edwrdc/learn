/**
 * Turn liveness unit tests (src/server/turn-liveness.ts).
 *
 * Two facts: BUSY is the committed run state (a chat with no open runtime
 * cannot be running here), and the in-process claim is the write-side mutex
 * (one turn per chat per process). The lifecycle events are announced
 * explicitly: turn-started after durable admission, turn-settled only after
 * the settle services made the record current.
 */

import "./support-tmp-data.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import "./support-durable.ts";
import { beginTurn, endTurn, isTurnRunning } from "../src/session/turn-liveness.ts";
import { runningTurn } from "../src/session/turn-runs.ts";
import { handleChatInput } from "../src/session/turn.ts";
import { chatStore } from "../src/session/store.ts";
import { subscribe } from "../src/platform/model/events.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

describe("turn claim", () => {
	it("begin/end round trip; a second begin is rejected until the turn ends", async () => {
		const id = "chat_liveness_unit";
		assert.equal(await isTurnRunning(id), false, "initially idle");
		assert.equal(beginTurn(id), true, "first turn accepted");
		assert.equal(await isTurnRunning(id), true, "the claim is live work");
		assert.equal(beginTurn(id), false, "no two turns for one chat");
		endTurn(id);
		assert.equal(await isTurnRunning(id), false, "cleared at finish");
		assert.equal(beginTurn(id), true, "a new turn may start after the last ended");
		endTurn(id);
	});
});

describe("turn lifecycle events", () => {
	it("a turn announces turn-started once, and turn-settled only once the record is current and the handle is gone", { timeout: 15_000 }, async () => {
		const chat = await chatStore.createChat("liveness events");
		await chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage([fauxText("settled reply")])]);
		const events: string[] = [];
		let settled!: (snapshot: Promise<{ handleGone: boolean; replied: boolean; running: boolean }>) => void;
		const atSettle = new Promise<Promise<{ handleGone: boolean; replied: boolean; running: boolean }>>((resolve) => (settled = resolve));
		const off = subscribe((e) => {
			if ((e as { chatId?: string }).chatId !== chat.id) return;
			if (e.type !== "turn-started" && e.type !== "turn-settled") return;
			events.push(e.type);
			if (e.type === "turn-settled") {
				const handleGone = runningTurn(chat.id) === undefined;
				settled(
					(async () => ({
						handleGone,
						replied: JSON.stringify((await chatStore.getChat(chat.id))!.messages).includes("settled reply"),
						running: await isTurnRunning(chat.id),
					}))(),
				);
			}
		});
		try {
			const res = await handleChatInput(chat.id, { type: "text", text: "hello" }, { engine: { model: faux.getModel(), streamFn: faux.streamSimple } });
			assert.equal(res.status, 200);
			const snapshot = await (await atSettle);
			assert.deepEqual(events, ["turn-started", "turn-settled"], "exactly one of each, in order");
			assert.equal(snapshot.handleGone, true, "the handle is unregistered before the announcement");
			assert.equal(snapshot.replied, true, "the record carries the reply when turn-settled fires");
			assert.equal(snapshot.running, false, "readers see the chat idle");
		} finally {
			off();
		}
	});
});
