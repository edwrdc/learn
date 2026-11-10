/**
 * The model catalog's server surface: pi-ai's catalog for every keyed
 * provider, projected to client-safe DTOs for the picker (GET /api/models),
 * plus the validation gate for settings writes.
 *
 * pi-ai owns all the data (catalog and per-model thinking levels); this
 * module only projects and validates — no second registry to drift. A
 * provider appears in the picker exactly when its key is present.
 */

import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
import { catalogModels, customEndpointState } from "./custom-endpoint.ts";
import { CUSTOM_ENDPOINT_KEY_ID, CUSTOM_ENDPOINT_PROVIDER_ID } from "./model/custom-endpoint.ts";
import { effectiveSettings } from "../stores.ts";
import { providerKeyPresent } from "./keys.ts";
import type { ModelChoice } from "./model/index.ts";
import {
	modelKey,
	type CatalogProvider,
	type ModelCatalogEntry,
	type ModelCatalogResponse,
	type ModelPin,
} from "./model/models.ts";
import type { EffectiveModelSpec } from "./model/resolution.ts";
import { AUTH_PROVIDER_KEYS } from "./model/auth-keys.ts";
import { BACKGROUND_MODEL_ROLES, MODEL_SLOTS, type ModelsSettings } from "./model/settings.ts";

/** Project a resolved spec to the client pin; null when nothing resolves
 *  (BYOK: no factory default, the UI shows "not configured"). */
export function pinOf(spec: EffectiveModelSpec | null | undefined): ModelPin | null {
	if (!spec) return null;
	return {
		model: { provider: spec.provider, id: spec.id },
		...(spec.thinkingLevel !== undefined ? { thinkingLevel: spec.thinkingLevel } : {}),
	};
}

export function pinsOf<K extends string>(
	names: readonly K[],
	specs: Record<K, EffectiveModelSpec | null | undefined>,
): Record<K, ModelPin | null> {
	return Object.fromEntries(names.map((name) => [name, pinOf(specs[name])])) as Record<K, ModelPin | null>;
}

/** One row per plain-key model provider (plus the custom endpoint), with
 *  keyPresent read fresh per call — saving a key immediately adds the
 *  provider to the picker. */
export function catalogProviders(): CatalogProvider[] {
	const custom = customEndpointState();
	const rows: CatalogProvider[] = AUTH_PROVIDER_KEYS.map((p) => ({
		id: p.id,
		envVar: p.envVar,
		keyPresent: providerKeyPresent(p.id),
	}));
	if (custom.endpoint) {
		rows.push({
			id: CUSTOM_ENDPOINT_PROVIDER_ID,
			envVar: CUSTOM_ENDPOINT_KEY_ID,
			keyPresent: custom.keyPresent,
		});
	}
	return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export function toModelDto(model: Model<Api>): ModelCatalogEntry {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider,
		reasoning: model.reasoning,
		input: [...model.input],
		supportedLevels: getSupportedThinkingLevels(model),
		cost:
			model.provider === CUSTOM_ENDPOINT_PROVIDER_ID
				? null
				: {
						input: model.cost.input,
						output: model.cost.output,
						cacheRead: model.cost.cacheRead,
						cacheWrite: model.cost.cacheWrite,
					},
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

/** provider:id → contextWindow over the same keyed providers the picker
 *  lists: the one server-side source for context-meter denominators. No
 *  fallback: a model missing here has no limit (owner decision). */
export function catalogContextLimits(): Map<string, number> {
	const keyed = new Set(catalogProviders().filter((p) => p.keyPresent).map((p) => p.id));
	const index = new Map<string, number>();
	const catalog = catalogModels();
	for (const provider of catalog.getProviders()) {
		if (!keyed.has(provider.id)) continue;
		for (const model of catalog.getModels(provider.id)) {
			index.set(modelKey(provider.id, model.id), model.contextWindow);
		}
	}
	return index;
}

/** The full picker payload: every model of every keyed provider, the
 *  new-session default, the background roles' and slots' resolved pins. */
export function modelCatalog(): ModelCatalogResponse {
	const keyed = new Set(catalogProviders().filter((p) => p.keyPresent).map((p) => p.id));
	const catalog = catalogModels();
	const effective = effectiveSettings();
	const models = catalog
		.getProviders()
		.filter((p) => keyed.has(p.id))
		.flatMap((p) => catalog.getModels(p.id))
		.map(toModelDto)
		.sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)));
	return {
		models,
		// The strong slot is the new-session default.
		defaults: pinOf(effective.models.strong),
		rolePins: pinsOf(BACKGROUND_MODEL_ROLES, effective.agent.models),
		slots: pinsOf(MODEL_SLOTS, effective.models),
		providers: catalogProviders(),
	};
}

export type SettingsValidation =
	| { ok: true }
	| { ok: false; error: string };

export function validateModelsSettings(settings: ModelsSettings): SettingsValidation {
	for (const name of MODEL_SLOTS) {
		const slot = settings[name];
		if (!slot) continue;
		const verdict = validateModelChoice(slot);
		if (!verdict.ok) return verdict;
	}
	return { ok: true };
}

/** The one catalog gate a settings write shares: a named provider must be
 *  configured, and its model must exist in that provider's catalog. */
export function validateModelChoice(slot: ModelChoice): SettingsValidation {
	const catalog = catalogModels();
	const providers = catalog.getProviders().map((p) => p.id);
	if (slot.model) {
		const { provider, id } = slot.model;
		if (!providers.includes(provider)) {
			return { ok: false, error: `Unknown provider "${provider}" — configured: ${providers.join(", ")}` };
		}
		if (!catalog.getModel(provider, id)) {
			return { ok: false, error: `No model "${id}" in the ${provider} catalog` };
		}
	}
	// Thinking levels never reject a write (owner decision): the check*
	// functions below clamp them instead.
	return { ok: true };
}

// Clamp-on-write (owner decision): a model swap with a pinned thinking level
// must just work — the pin translates to the new model's nearest supported
// level (the same clamp piEngineForSpec applies at runtime), and the clamped
// value is what lands in the record.

function clampLevelFor(provider: string, id: string, level: ThinkingLevel): ThinkingLevel {
	const model = catalogModels().getModel(provider, id);
	return model ? clampThinkingLevel(model, level) : level;
}

/** Every slot's pinned thinkingLevel clamps against the slot's own model. */
export function clampModelsLevels(settings: ModelsSettings): ModelsSettings {
	const out: ModelsSettings = {};
	for (const name of MODEL_SLOTS) {
		const slot = settings[name];
		if (!slot?.model) continue;
		out[name] =
			slot.thinkingLevel !== undefined
				? {
						model: slot.model,
						thinkingLevel: clampLevelFor(slot.model.provider, slot.model.id, slot.thinkingLevel),
					}
				: slot;
	}
	return out;
}

/** A chat's pinned thinkingLevel clamps against its own model, else the
 *  strong slot's. No model anywhere → unchecked (the runtime clamps at
 *  engine build). */
export function clampChatLevel(settings: ModelChoice, strong: EffectiveModelSpec | null): ModelChoice {
	if (settings.thinkingLevel === undefined) return settings;
	const provider = settings.model?.provider ?? strong?.provider;
	const id = settings.model?.id ?? strong?.id;
	if (!provider || !id) return settings;
	return { ...settings, thinkingLevel: clampLevelFor(provider, id, settings.thinkingLevel) };
}

/** A model choice the catalog accepts, with its thinking level clamped, or
 *  the 400 refusal. */
type CheckedModels<T> = { ok: true; value: T } | { ok: false; error: string };

export function checkModelsSettings(settings: ModelsSettings): CheckedModels<ModelsSettings> {
	const verdict = validateModelsSettings(settings);
	return verdict.ok ? { ok: true, value: clampModelsLevels(settings) } : verdict;
}

export function checkChatSettings(settings: ModelChoice, strong: EffectiveModelSpec | null): CheckedModels<ModelChoice> {
	const verdict = validateModelChoice(settings);
	return verdict.ok ? { ok: true, value: clampChatLevel(settings, strong) } : verdict;
}
