
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { UserSettings } from "../src/core/settings.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-lifecycle-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

const { saveCustomEndpoint, removeCustomEndpoint } = await import("../src/server/custom-endpoint.ts");
const { stores } = await import("../src/server/stores.ts");
const { settingsStore } = stores;

const BASE_URL = "http://127.0.0.1:9/v1";
const KEY = "test-lifecycle-key-123456";
const UNRELATED = ["general", "models", "agent", "appearance", "graph", "compaction", "unknownSection"] as const;

const endpoint = {
	id: "lifecycle-model",
	name: "Lifecycle Model",
	contextWindow: 64_000,
	maxTokens: 8_192,
	reasoning: true,
	imageInput: false,
};

const SEED: UserSettings = {
	version: 1,
	general: { autoUpdate: false },
	models: {
		strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "low" },
		cheap: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } },
		vision: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" }, thinkingLevel: "medium" },
	},
	agent: {
		models: {
			researcher: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" }, thinkingLevel: "high" },
			auditor: { thinkingLevel: "low" },
		},
		tools: { demo: false, visual: true },
		prompts: { "teacher/body.md": true },
		search: { engine: "tavily" },
		graphTools: { enabled: false },
	},
	appearance: {
		mode: "light",
		background: "#101820",
		fontFamily: "Georgia",
		proseFontSize: 18,
		sessionNameSerif: false,
		mdRendering: { headingWeight: 700, boldColor: "#ff0000", italicColor: "#00ff00" },
	},
	graph: { enabled: false, rendering: false, extractionChunkTokens: 6000 },
	compaction: { thresholdTokens: 50_000 },
	unknownSection: { keep: ["me"], nested: { n: 1 } },
};

let seeded: UserSettings;

before(() => {
	settingsStore.writeSettings(SEED);
	seeded = settingsStore.readSettings()!;
});

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

function assertUnrelatedPreserved(step: string): void {
	const record = settingsStore.readSettings();
	assert.ok(record, `${step}: settings record exists`);
	for (const key of UNRELATED) {
		assert.deepEqual(record[key], seeded[key], `${step}: ${key} survives`);
	}
	assert.equal(record.version, seeded.version, `${step}: version survives`);
}

describe("custom endpoint lifecycle preserves the settings record", () => {
	it("first save → edit → remove → re-add preserves every unrelated setting", () => {
		const first = saveCustomEndpoint({ displayName: "First", baseUrl: BASE_URL, models: [endpoint], apiKey: KEY });
		assert.ok(first.ok, first.ok ? "" : first.error);
		assertUnrelatedPreserved("first save");
		assert.equal(settingsStore.readSettings()?.customEndpoint?.displayName, "First");

		const edited = saveCustomEndpoint({
			displayName: "Edited",
			baseUrl: BASE_URL,
			models: [{ ...endpoint, contextWindow: 128_000 }],
		});
		assert.ok(edited.ok, edited.ok ? "" : edited.error);
		assertUnrelatedPreserved("edit");
		const editedRecord = settingsStore.readSettings();
		assert.equal(editedRecord?.customEndpoint?.displayName, "Edited");
		assert.equal(editedRecord?.customEndpoint?.models[0]?.contextWindow, 128_000);

		const removed = removeCustomEndpoint();
		assert.equal(removed.endpoint, null);
		assertUnrelatedPreserved("remove");
		assert.equal(settingsStore.readSettings()?.customEndpoint, undefined);

		const readded = saveCustomEndpoint({
			displayName: "Re-added",
			baseUrl: BASE_URL,
			models: [endpoint],
			apiKey: KEY,
		});
		assert.ok(readded.ok, readded.ok ? "" : readded.error);
		assertUnrelatedPreserved("re-add");
		assert.equal(settingsStore.readSettings()?.customEndpoint?.displayName, "Re-added");
	});
});
