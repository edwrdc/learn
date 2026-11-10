/**
 * Turn liveness unit tests (src/server/turn-liveness.ts).
 *
 * Two facts: BUSY is the committed run state (a chat with no open runtime
 * cannot be running here), and the in-process claim is the write-side mutex
 * (one turn per chat per process). The lifecycle events are announced
 * explicitly: turn-started after durable admission, turn-settled only after
 * the settle services made the record current.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	beginTurn,
	endTurn,
	isTurnRunning,
	noteTurnSettled,
} from "../src/session/turn-liveness.ts";
import { registerTurn, runningTurn } from "../src/session/turn-runs.ts";
import type { PiTurnHandle } from "../src/session/pi/durable-turn.ts";
import { subscribe, type ServerEvent } from "../src/platform/model/events.ts";

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
	it("registering the handle announces the turn; the rejected double-begin stays silent; endTurn drops the handle", () => {
		const id = "chat_events_begin";
		const got: ServerEvent[] = [];
		const off = subscribe((e) => got.push(e));
		assert.equal(beginTurn(id), true, "fresh chat accepts the turn");
		assert.equal(beginTurn(id), false, "the rejected double-begin");
		registerTurn(id, {} as PiTurnHandle);
		assert.deepEqual(got, [{ type: "turn-started", chatId: id }], "exactly one event");
		endTurn(id);
		assert.equal(runningTurn(id), undefined, "the claim release drops the handle");
		off();
	});

	it("noteTurnSettled announces only after the settle services ran", () => {
		const id = "chat_events_end";
		const got: ServerEvent[] = [];
		const off = subscribe((e) => got.push(e));
		beginTurn(id);
		endTurn(id); // the mutex release is silent
		assert.deepEqual(got, [], "no event from the claim alone");
		noteTurnSettled(id);
		assert.deepEqual(got, [{ type: "turn-settled", chatId: id }]);
		off();
	});
});
