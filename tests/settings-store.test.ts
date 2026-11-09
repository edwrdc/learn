/**
 * Tests for the settings STORE (settings-storage wave, 2026-09-19):
 * src/store/settings.ts — the record's fs adapter. Writes the real repo
 * data/ files (npm test's shared data/, disposable scratch by doctrine)
 * and cleans up after itself; a pre-existing settings.json is snapshotted
 * and restored so the worktree's own dev state survives the run.
 *
 * (The legacy default-settings.json fold and the chat-section facade died
 * with per-session models, owner 2026-09-28 — sessions own their model
 * from birth, stamped from the strong slot server-side.)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { SETTINGS_FILE } from "../src/platform/config.ts";
import { readSettings, writeSettings } from "../src/settings/store.ts";
import { resolveSettings } from "../src/settings/model/resolution.ts";

// Snapshot any pre-existing record; restore in after() so the worktree's
// own dev state survives a test run.
let hadSettings = false;
let savedSettings = "";
try {
	savedSettings = fs.readFileSync(SETTINGS_FILE, "utf-8");
	hadSettings = true;
} catch {
	/* first boot — nothing to snapshot */
}
after(() => {
	if (hadSettings) fs.writeFileSync(SETTINGS_FILE, savedSettings, "utf-8");
	else fs.rmSync(SETTINGS_FILE, { force: true });
});

afterEach(() => {
	fs.rmSync(SETTINGS_FILE, { force: true });
});

describe("the settings store", () => {
	it("reads null on first boot (no record)", () => {
		fs.rmSync(SETTINGS_FILE, { force: true });
		assert.equal(readSettings(), null);
	});

	it("write→read round-trips through the sanitizer", () => {
		writeSettings({ version: 1, graph: { enabled: false } });
		const out = readSettings();
		assert.ok(out);
		assert.deepEqual(out.graph, { enabled: false });
	});

	it("sanitizes independent sections on disk reads and writes without losing unknown keys", () => {
		for (const graph of [undefined, { enabled: false }]) {
			for (const [thresholdTokens, compaction, effectiveThreshold] of [
				[-5, {}, 150_000],
				[1, { thresholdTokens: 32_000 }, 32_000],
				[96_000.9, { thresholdTokens: 96_000 }, 96_000],
			] as const) {
				const raw = {
					version: 2,
					general: [],
					agent: null,
					appearance: false,
					models: { strong: "invalid" },
					customEndpoint: { baseUrl: "invalid" },
					graph,
					compaction: { thresholdTokens },
					futureSection: { knob: [1, false] },
				};
				const expected = { version: 2, ...(graph ? { graph } : {}), compaction, futureSection: raw.futureSection };
				fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
				const disk = JSON.stringify(raw);
				fs.writeFileSync(SETTINGS_FILE, disk, "utf-8");
				const read = readSettings();
				assert.deepEqual(read, expected);
				assert.equal(resolveSettings(read).compaction.thresholdTokens, effectiveThreshold);
				assert.equal(fs.readFileSync(SETTINGS_FILE, "utf-8"), disk, "reads do not rewrite the stored record");
				assert.deepEqual(writeSettings(raw), expected);
				assert.deepEqual(JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")), expected);
				assert.deepEqual(readSettings(), expected);
			}
		}
	});

	it("a chat section on disk is IGNORED — the field died with per-session models (owner, 2026-09-28)", () => {
		fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
		// A fossil `chat` section (the old default-settings record) must not
		// resurrect through the sanitizer — the key is simply gone.
		fs.writeFileSync(
			SETTINGS_FILE,
			JSON.stringify({
				version: 1,
				chat: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "low" },
				graph: { enabled: true },
			}),
			"utf-8",
		);
		const out = readSettings();
		assert.ok(out);
		assert.equal("chat" in out, false, "the chat section never surfaces");
		assert.deepEqual(out.graph, { enabled: true }); // siblings survive
	});

	it("corrupt settings.json → null (first-boot semantics), never throws", () => {
		fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
		fs.writeFileSync(SETTINGS_FILE, "{not json", "utf-8");
		assert.equal(readSettings(), null);
	});
});
