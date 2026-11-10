/**
 * provider-events — the raw-wire recorder pins (owner, 2026-10-04).
 *
 * The recorder is env-gated debug tooling (LH_PROVIDER_EVENTS=1); these
 * pins hold its mechanics: off = zero surface (no observer, no file),
 * on = one JSONL per chat under data/debug/provider-events/, safe
 * degradation on non-serializable adapter payloads, and the byte cap
 * that stops a runaway turn from filling the disk.
 */

import "./support-tmp-data.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../src/platform/config.ts";
import {
	providerEventNote,
	providerEventObserver,
	providerEventsEnabled,
	PROVIDER_EVENTS_CAP_BYTES,
} from "../src/platform/provider-events.ts";

const ENV = "LH_PROVIDER_EVENTS";
const DIR = path.join(PATHS.debug, "provider-events");

function readLines(dir: string, chatId: string): Array<Record<string, unknown>> {
	const file = path.join(dir, `${chatId}.jsonl`);
	return fs
		.readFileSync(file, "utf-8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Enable the recorder for one test. */
function withRecorder(t: { after: (fn: () => void) => void }): string {
	process.env[ENV] = "1";
	t.after(() => {
		delete process.env[ENV];
	});
	return DIR;
}

test("env off: no observer, no note, no file — zero surface", (t) => {
	const dir = DIR;
	delete process.env[ENV];
	t.after(() => {
		delete process.env[ENV];
	});

	assert.equal(providerEventsEnabled(), false);
	assert.equal(providerEventObserver("chat_x", "teacher"), undefined);
	providerEventNote("chat_x", "teacher", "run start"); // must be a silent no-op
	assert.equal(fs.existsSync(path.join(dir, "chat_x.jsonl")), false, "nothing written while off");
});

test("env on: observer writes pinned-shape JSONL lines", (t) => {
	const dir = withRecorder(t);

	const observe = providerEventObserver("chat_y", "teacher");
	assert.ok(observe, "enabled → observer exists");
	observe!({ type: "raw", delta: "hello" }, { provider: "openrouter", id: "z-ai/glm-5.3-flash" });
	providerEventNote("chat_y", "teacher", "run end");

	const lines = readLines(dir, "chat_y");
	assert.equal(lines.length, 2);
	assert.deepEqual(
		{ ...lines[0], t: 0 },
		{ t: 0, ctx: "teacher", provider: "openrouter", model: "z-ai/glm-5.3-flash", event: { type: "raw", delta: "hello" } },
		"event line: {t, ctx, provider, model, event}",
	);
	assert.match(String(lines[1]!.note), /run end/);
});

test("non-serializable adapter payloads degrade to a type note, never throw", (t) => {
	const dir = withRecorder(t);

	const cyclic: Record<string, unknown> = { type: "chunk" };
	cyclic.self = cyclic;
	const observe = providerEventObserver("chat_c", "prober");
	observe!(cyclic, { provider: "anthropic", id: "claude-fable-5" });

	const [line] = readLines(dir, "chat_c");
	assert.deepEqual(line!.event, { __nonSerializable: "object" });
});

test("the byte cap writes one marker and stops recording", (t) => {
	const dir = withRecorder(t);

	const observe = providerEventObserver("chat_cap", "teacher");
	assert.ok(observe);
	observe!({ type: "a", pad: "x".repeat(PROVIDER_EVENTS_CAP_BYTES) }, { provider: "p", id: "m" }); // crosses → written + marker
	observe!({ type: "b" }, { provider: "p", id: "m" }); // capped: dropped

	const lines = readLines(dir, "chat_cap");
	assert.equal(lines.length, 2, "one event + one cap marker");
	assert.match(String(lines.at(-1)!.note), new RegExp(`cap ${PROVIDER_EVENTS_CAP_BYTES} bytes reached`));
	assert.equal(lines.some((l) => (l.event as { type?: string })?.type === "b"), false, "post-cap event dropped");
});
