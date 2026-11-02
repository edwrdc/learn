/** The Svelte ServerEventHub against a driven fake EventSource: typed
 *  dispatch, resync-on-open, error isolation, unparseable frames, close. */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { ServerEventHub } from "../src/lib/state/server-events.ts";

class FakeSource {
	static instance: FakeSource | null = null;
	closed = false;
	private events = new Map<string, Set<(event: MessageEvent) => void>>();
	private opens = new Set<() => void>();
	constructor(public url: string) {
		FakeSource.instance = this;
	}
	addEventListener(name: string, cb: (event: MessageEvent) => void) {
		const set = this.events.get(name) ?? new Set();
		this.events.set(name, set);
		set.add(cb);
	}
	set onopen(cb: () => void) {
		this.opens.add(cb);
	}
	close() {
		this.closed = true;
	}
	push(name: string, payload: unknown) {
		const data = typeof payload === "string" ? payload : JSON.stringify(payload);
		for (const cb of this.events.get(name) ?? []) cb({ data } as MessageEvent);
	}
	open() {
		for (const cb of this.opens) cb();
	}
}

const previousES = globalThis.EventSource;
const previousWindow = (globalThis as { window?: unknown }).window;
Object.assign(globalThis, { window: globalThis, EventSource: FakeSource as unknown as typeof EventSource });
after(() => {
	Object.assign(globalThis, { EventSource: previousES });
	if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
	else (globalThis as { window?: unknown }).window = previousWindow;
});

function hubWithSource() {
	const hub = new ServerEventHub();
	hub.start();
	return { hub, src: FakeSource.instance! };
}

describe("server event hub", () => {
	it("dispatches named frames to the right subscriber with parsed payload", () => {
		const { hub, src } = hubWithSource();
		const got: string[] = [];
		hub.subscribe("turn-started", (payload) => got.push(payload.chatId));
		hub.subscribe("turn-settled", (payload) => got.push(`settled:${payload.chatId}`));
		src.push("turn-started", { chatId: "chat_wire" });
		src.push("turn-settled", { chatId: "chat_wire" });
		src.push("jobs-changed", { chatId: "chat_wire" });
		assert.deepEqual(got, ["chat_wire", "settled:chat_wire"]);
		hub.stop();
	});

	it("fires resync on every open (initial and reconnect)", () => {
		const { hub, src } = hubWithSource();
		let resyncs = 0;
		hub.onResync(() => resyncs++);
		src.open();
		src.open();
		assert.equal(resyncs, 2);
		hub.stop();
	});

	it("isolates a throwing handler from its neighbors", () => {
		const { hub, src } = hubWithSource();
		hub.subscribe("chats-changed", () => {
			throw new Error("handler bug");
		});
		const got: number[] = [];
		hub.subscribe("chats-changed", () => got.push(1));
		const original = console.error;
		console.error = () => {};
		try {
			src.push("chats-changed", {});
		} finally {
			console.error = original;
		}
		assert.deepEqual(got, [1]);
		hub.stop();
	});

	it("drops an unparseable frame loudly without half-firing", () => {
		const { hub, src } = hubWithSource();
		let calls = 0;
		hub.subscribe("activity-changed", () => calls++);
		const original = console.error;
		console.error = () => {};
		try {
			src.push("activity-changed", "{not json");
		} finally {
			console.error = original;
		}
		assert.equal(calls, 0);
		hub.stop();
	});

	it("unsubscribe stops delivery; stop closes the source", () => {
		const { hub, src } = hubWithSource();
		let calls = 0;
		const off = hub.subscribe("chats-changed", () => calls++);
		src.push("chats-changed", {});
		off();
		src.push("chats-changed", {});
		assert.equal(calls, 1);
		assert.equal(src.closed, false);
		hub.stop();
		assert.equal(src.closed, true);
	});

	it("start is idempotent and stop allows a fresh start", () => {
		const hub = new ServerEventHub();
		hub.start();
		const first = FakeSource.instance;
		hub.start();
		assert.equal(FakeSource.instance, first);
		hub.stop();
		hub.start();
		assert.notEqual(FakeSource.instance, first);
		hub.stop();
	});
});
