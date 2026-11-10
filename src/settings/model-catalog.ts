/**
 * The model catalog's server surface (model-control wave, 2026-09-12;
 * federated since the model-slots wave, 2026-09-20): pi-ai's catalog for
 * every KEYED provider, projected to client-safe DTOs for the picker (GET
 * /api/models), plus the validation gate for settings writes (PUT
 * /api/settings/* — the per-chat settings PUT is retired from the UI;
 * legacy records' per-chat overrides still resolve server-side).
 *
 * pi-ai owns ALL the data: the catalog (id/name/cost/context/modality/
 * thinkingLevelMap) and the per-model thinking truth
 * (getSupportedThinkingLevels / clampThinkingLevel). This module only
 * projects and validates — no second registry to drift out of sync.
 *
 * Federation: `getModels()` is called per keyed provider (federated, the
 * model-slots wave), so a provider appears in the picker exactly when its
 * key is present — piModels() in src/platform/engines.ts owns the provider
 * set; nothing here changes.
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
 *  (BYOK: no factory floor, the UI shows "not configured"). */
export function pinOf(spec: EffectiveModelSpec | null | undefined): ModelPin | null {
	if (!spec) return null;
	return {
		model: { provider: spec.provider, id: spec.id },
		...(spec.thinkingLevel !== undefined ? { thinkingLevel: spec.thinkingLevel } : {}),
	};
}

/** Pins for every name in `names`, read from the resolved specs. */
export function pinsOf<K extends string>(
	names: readonly K[],
	specs: Record<K, EffectiveModelSpec | null | undefined>,
): Record<K, ModelPin | null> {
	return Object.fromEntries(names.map((name) => [name, pinOf(specs[name])])) as Record<K, ModelPin | null>;
}

/** The providers surface (model slots wave, 2026-09-20): one row per
 *  plain-key model provider (core/auth-keys.ts's pi-ai-derived table),
 *  with keyPresent read env-wins through the keys seam, fresh per call —
 *  saving a key immediately federates the provider into the picker. */
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

/** Project one catalog model to the client DTO. */
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

/** The live-limits index (context-meter amendment, owner 2026-09-23):
 *  provider:id → contextWindow from pi's catalog, over the SAME keyed
 *  providers the picker federates. The one source for every context
 *  meter's denominator — the stats-bar join holds /api/models' copy,
 *  and the activity feed (observability.ts) resolves job limits
 *  server-side through this. No hardcoded fallback exists anywhere:
 *  a model missing here reads limit-null (usage-only, honest render). */
export function catalogContextLimits(): Map<string, number> {
	// The picker lists only providers whose key is present (the Keys page
	// is where the others are discovered).
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

/** The full picker payload: every model of every configured provider
 *  (sorted by provider then id — stable, diff-friendly) + the config
 *  defaults a settings-less chat runs + the background roles' resolved
 *  pins (the settings UI's per-role default captions). */
export function modelCatalog(): ModelCatalogResponse {
	// The picker lists only providers whose key is present (the Keys page
	// is where the others are discovered).
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
		// The strong slot is the new-session default (per-session models).
		defaults: pinOf(effective.models.strong),
		rolePins: pinsOf(BACKGROUND_MODEL_ROLES, effective.agent.models),
		slots: pinsOf(MODEL_SLOTS, effective.models),
		providers: catalogProviders(),
	};
}

/** One validated outcome for a settings write. */
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
	// BYOK interlude (owner, 2026-09-22): thinking levels NEVER reject a
	// write — a model swap with a pinned level JUST WORKS. The WRITE clamps
	// the pin to the new model's nearest supported level (clampChatLevel /
	// clampModelsLevels below, applied by the routes) and stores the clamped
	// result; a bare level with no model anywhere rides unchecked and clamps
	// against whatever the chain later holds at engine build.
	return { ok: true };
}

// ─── clamp-on-write (owner ruling, interlude 2026-09-22) ─────────────────────
// A model swap with a pinned thinking level must JUST WORK: the pin
// translates to the new model's nearest supported level — pi's
// clampThinkingLevel, the SAME translation piEngineForSpec applies at
// runtime — and the clamped value is what lands in the record. The
// server is the truth: the record shows the clamped level after write.

/** Clamp one level against one model (identity when the model is unknown
 *  or the level already supported — the existence gate rejects unknown
 *  models separately, so this only ever sees real ones in practice). */
function clampLevelFor(provider: string, id: string, level: ThinkingLevel): ThinkingLevel {
	const model = catalogModels().getModel(provider, id);
	return model ? clampThinkingLevel(model, level) : level;
}

/** The models-section write's level translation: every slot's pinned
 *  thinkingLevel clamps against THE SLOT'S OWN model (the parser requires
 *  a model on every slot write — owner, 2026-09-22). Pure: catalog in,
 *  clamped section out; the route applies it after validation. */
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

/** The chat-section write's level translation: a pinned thinkingLevel
 *  clamps against the body's own model, else the record's resolved strong
 *  slot (the conversation chain's fallback — what a settings-less chat
 *  would run). No model anywhere → rides unchecked (runtime clamps at
 *  engine build; the turn gate refuses the model-less chat anyway). */
export function clampChatLevel(settings: ModelChoice, strong: EffectiveModelSpec | null): ModelChoice {
	if (settings.thinkingLevel === undefined) return settings;
	const provider = settings.model?.provider ?? strong?.provider;
	const id = settings.model?.id ?? strong?.id;
	if (!provider || !id) return settings;
	return { ...settings, thinkingLevel: clampLevelFor(provider, id, settings.thinkingLevel) };
}

/** A model choice the catalog accepts, with its thinking level clamped
 *  (levels never reject a write), or the 400 refusal. */
type CheckedModels<T> = { ok: true; value: T } | { ok: false; error: string };

export function checkModelsSettings(settings: ModelsSettings): CheckedModels<ModelsSettings> {
	const verdict = validateModelsSettings(settings);
	return verdict.ok ? { ok: true, value: clampModelsLevels(settings) } : verdict;
}

/** A chat's level clamps against its own model, else the strong slot's. */
export function checkChatSettings(settings: ModelChoice, strong: EffectiveModelSpec | null): CheckedModels<ModelChoice> {
	const verdict = validateModelChoice(settings);
	return verdict.ok ? { ok: true, value: clampChatLevel(settings, strong) } : verdict;
}
