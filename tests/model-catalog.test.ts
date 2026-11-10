import "./support-tmp-data.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { checkChatSettings, checkModelsSettings, modelCatalog } from "../src/settings/model-catalog.ts";
import type { EffectiveModelSpec } from "../src/settings/model/resolution.ts";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { BACKGROUND_MODEL_ROLES, DEFAULT_THINKING_ORDER, type UserSettings } from "../src/settings/model/settings.ts";
import { piEngineForSpec, piModels } from "../src/platform/engines.ts";
import { SETTINGS_FILE } from "../src/platform/config.ts";
import { writeSettings } from "../src/settings/store.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-openrouter-catalog";

const GLM = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };
const QWEN_FLASH = { provider: "openrouter", id: "qwen/qwen3.8-flash" };

/** This file owns its temp data dir: null clears the record. */
function useRecord(record: UserSettings | null) {
	if (record) writeSettings(record);
	else fs.rmSync(SETTINGS_FILE, { force: true });
}

function glmModel() {
	const glm = piModels().getModel("openrouter", "z-ai/glm-5.3-flash");
	assert.ok(glm, "glm-5.3-flash in catalog");
	return glm!;
}

describe("the model catalog projection", () => {
	it("serves the keyed providers' catalogs with the picker's DTO shape", () => {
		useRecord(null);
		const { models, providers } = modelCatalog();
		assert.ok(models.length > 300, `expected a full catalog, got ${models.length}`);
		for (const m of models.slice(0, 25)) {
			assert.equal(typeof m.id, "string");
			assert.equal(typeof m.name, "string");
			assert.ok(Array.isArray(m.supportedLevels));
			assert.ok(m.cost === null || (typeof m.cost.input === "number" && typeof m.cost.output === "number"));
			assert.ok(m.contextWindow > 0);
		}
		const glm = models.find((m) => m.id === "z-ai/glm-5.3-flash");
		assert.ok(glm, "glm-5.3-flash in catalog");
		assert.deepEqual(glm!.supportedLevels, ["low", "high", "max"]);
		assert.deepEqual(glm!.input, ["text", "image"]);
		assert.deepEqual(glm!.cost, { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 });
		const openrouter = providers.find((p) => p.id === "openrouter");
		assert.ok(openrouter && openrouter.keyPresent, "openrouter federated (key pinned above)");
		assert.ok(providers.some((p) => !p.keyPresent), "keyless providers listed for discovery");
		const keyless = providers.filter((p) => !p.keyPresent).map((p) => p.id);
		for (const id of keyless) {
			assert.ok(!models.some((m) => m.provider === id), `keyless ${id} must not federate`);
		}
	});

	it("no record: no default, every slot and role pin is null (BYOK: no phantom defaults)", () => {
		useRecord(null);
		const { defaults, slots, rolePins } = modelCatalog();
		assert.equal(defaults, null);
		assert.deepEqual(slots, { strong: null, cheap: null, vision: null });
		for (const role of BACKGROUND_MODEL_ROLES) assert.equal(rolePins[role], null, role);
	});

	it("defaults is the strong slot verbatim; slots and role pins project the record's tiers", () => {
		useRecord({
			version: 1,
			models: { strong: { model: GLM, thinkingLevel: "low" }, cheap: { model: QWEN_FLASH } },
			agent: { models: { researcher: { model: GLM, thinkingLevel: "high" } } },
		});
		try {
			const { defaults, slots, rolePins } = modelCatalog();
			assert.deepEqual(defaults, { model: GLM, thinkingLevel: "low" });
			assert.deepEqual(slots, { strong: { model: GLM, thinkingLevel: "low" }, cheap: { model: QWEN_FLASH }, vision: null });
			assert.deepEqual(rolePins.researcher, { model: GLM, thinkingLevel: "high" }, "the override wins for its role");
			assert.deepEqual(rolePins.auditor, { model: QWEN_FLASH }, "the cheap slot re-tiers its roles; level unset");
			assert.equal(rolePins.visualMaker, null, "vision tier untouched");
		} finally {
			useRecord(null);
		}
	});

	it("provider keys are read fresh per call", () => {
		const zai = () => modelCatalog().providers.find((p) => p.id === "zai")?.keyPresent;
		assert.equal(zai(), false);
		const saved = process.env.ZAI_API_KEY;
		process.env.ZAI_API_KEY = "test-zai-key-1234567890";
		try {
			assert.equal(zai(), true);
		} finally {
			if (saved === undefined) delete process.env.ZAI_API_KEY;
			else process.env.ZAI_API_KEY = saved;
		}
	});
});

describe("checkModelsSettings (the models-section write gate)", () => {
	it("accepts a valid slot and rejects unknown provider/model", () => {
		assert.equal(checkModelsSettings({ strong: { model: GLM } }).ok, true);
		assert.equal(checkModelsSettings({ cheap: { model: { provider: "nope", id: "x" } } }).ok, false);
		assert.equal(checkModelsSettings({ vision: { model: { provider: "openrouter", id: "nope/nope" } } }).ok, false);
	});

	it("thinking levels never reject a slot write — the slot's own model clamps the pin (owner, interlude 2026-09-22)", () => {
		assert.deepEqual(checkModelsSettings({ strong: { model: GLM, thinkingLevel: "xhigh" } }), {
			ok: true,
			value: { strong: { model: GLM, thinkingLevel: "max" } },
		});
		assert.deepEqual(checkModelsSettings({ strong: { model: GLM, thinkingLevel: "minimal" } }), {
			ok: true,
			value: { strong: { model: GLM, thinkingLevel: "low" } },
		});
		assert.deepEqual(
			checkModelsSettings({ strong: { model: GLM, thinkingLevel: "off" } }),
			{ ok: true, value: { strong: { model: GLM, thinkingLevel: "low" } } },
			"glm cannot disable thinking: off clamps UP to low",
		);
		assert.deepEqual(checkModelsSettings({ strong: { model: GLM, thinkingLevel: "high" } }), {
			ok: true,
			value: { strong: { model: GLM, thinkingLevel: "high" } },
		});
		assert.deepEqual(
			checkModelsSettings({ strong: { model: GLM } }),
			{ ok: true, value: { strong: { model: GLM } } },
			"the server never invents a level",
		);
	});

	it("accepts empty settings (the clear-slots write)", () => {
		assert.deepEqual(checkModelsSettings({}), { ok: true, value: {} });
	});
});

describe("checkChatSettings (the chat write gate)", () => {
	const strong: EffectiveModelSpec = { ...GLM };

	it("thinking levels never reject a chat write: the body's model, else the strong slot, clamps the pin", () => {
		assert.deepEqual(
			checkChatSettings({ model: { provider: "openrouter", id: "qwen/qwen3.8-max-0902" }, thinkingLevel: "xhigh" }, strong),
			{ ok: true, value: { model: { provider: "openrouter", id: "qwen/qwen3.8-max-0902" }, thinkingLevel: "xhigh" } },
			"the body's own model wins (qwen supports xhigh; the strong glm would clamp it)",
		);
		assert.deepEqual(checkChatSettings({ thinkingLevel: "xhigh" }, strong), { ok: true, value: { thinkingLevel: "max" } });
		assert.deepEqual(
			checkChatSettings({ thinkingLevel: "minimal" }, null),
			{ ok: true, value: { thinkingLevel: "minimal" } },
			"no model anywhere rides unchecked",
		);
		assert.deepEqual(checkChatSettings({ model: { ...GLM } }, strong), { ok: true, value: { model: { ...GLM } } });
	});

	it("rejects unknown providers and models", () => {
		assert.equal(checkChatSettings({ model: { provider: "nope", id: "x/y" } }, null).ok, false);
		assert.equal(checkChatSettings({ model: { provider: "openrouter", id: "nope/nope" } }, null).ok, false);
	});

	it("accepts empty settings (the clear-overrides write)", () => {
		assert.deepEqual(checkChatSettings({}, null), { ok: true, value: {} });
	});
});

describe("pi thinking truth (pinned against pi-ai upgrades)", () => {
	it("glm-5.3-flash: low|high|max; anything else clamps to the nearest", () => {
		const glm = glmModel();
		assert.deepEqual(getSupportedThinkingLevels(glm), ["low", "high", "max"]);
		assert.equal(clampThinkingLevel(glm, "minimal"), "low");
		assert.equal(clampThinkingLevel(glm, "off"), "low", "GLM cannot disable thinking (map: off → null)");
		assert.equal(clampThinkingLevel(glm, "xhigh"), "max");
		assert.equal(clampThinkingLevel(glm, "high"), "high");
	});

	it("the engine factory clamps explicit levels; unknown models throw honestly", () => {
		const over = piEngineForSpec({ provider: "openrouter", id: "qwen/qwen3.8-flash", thinkingLevel: "high" });
		assert.equal(over.model.id, "qwen/qwen3.8-flash");
		assert.equal(over.level, "high");
		const clamped = piEngineForSpec({ provider: "openrouter", id: "z-ai/glm-5.3-flash", thinkingLevel: "minimal" });
		assert.equal(clamped.level, "low");
		assert.throws(() => piEngineForSpec({ provider: "openrouter", id: "nope/nope", thinkingLevel: "low" }), /catalog has no model/);
	});

	it("UNSET levels resolve from the baked DEFAULT_THINKING_ORDER (owner, 2026-09-22)", () => {
		assert.deepEqual([...DEFAULT_THINKING_ORDER], ["medium", "low", "high", "minimal", "xhigh", "max"]);
		// glm supports low|high|max → first supported in the order is "low"
		const glm = piEngineForSpec({ provider: "openrouter", id: "z-ai/glm-5.3-flash" });
		assert.equal(glm.level, "low");
		// explicit levels never consult the order — pi clamps nearest
		assert.equal(piEngineForSpec({ provider: "openrouter", id: "z-ai/glm-5.3-flash", thinkingLevel: "max" }).level, "max");
		// a non-reasoning model reports exactly ["off"] → the order lands there
		const flat = piModels()
			.getProviders()
			.flatMap((p) => piModels().getModels(p.id))
			.find((m) => !m.reasoning);
		if (flat) {
			const engine = piEngineForSpec({ provider: flat.provider, id: flat.id });
			assert.deepEqual(getSupportedThinkingLevels(flat), ["off"]);
			assert.equal(engine.level, "off");
		}
	});

});