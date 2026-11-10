/**
 * Model-catalog contracts — the client-safe shapes of GET /api/models. The
 * server projection lives in src/settings/model-catalog.ts.
 */
import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
import type { BackgroundModelRole, ModelSlotName } from "./settings.ts";

/** A model's app-wide key, `<provider>:<id>` (usage, prices, limits). */
export function modelKey(provider: string, id: string): string {
	return `${provider}:${id}`;
}

/** The inverse of modelKey; a bare id has no provider. */
export function parseModelKey(key: string): { provider: string | null; id: string } {
	const colon = key.indexOf(":");
	if (colon === -1) return { provider: null, id: key };
	return { provider: key.slice(0, colon), id: key.slice(colon + 1) };
}

/** One picker row, projected from pi-ai's catalog. Costs are USD per 1M
 *  tokens; null means the price is unknown (custom endpoints) and the UI
 *  must say so rather than show a fabricated zero. */
export interface ModelCatalogEntry {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	/** The thinking levels this model accepts (pi's thinkingLevelMap — e.g.
	 *  GLM-5.3-flash: low|high|max). The picker lists exactly these. */
	supportedLevels: ThinkingLevel[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
	contextWindow: number;
	maxTokens: number;
}

/** A resolved model pin: the model, plus its thinking level when one is
 *  stored (unset resolves from DEFAULT_THINKING_ORDER at engine build). */
export interface ModelPin {
	model: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
}

/** Each background role's resolved pin: role override → tier slot →
 *  nothing (BYOK). Null = the chain is empty and the role's work is refused. */
type RolePins = Record<BackgroundModelRole, ModelPin | null>;

/** Each slot tier's resolved pin; null = the tier holds no model. */
type SlotPins = Record<ModelSlotName, ModelPin | null>;

/** GET /api/models response. */
export interface ModelCatalogResponse {
	models: ModelCatalogEntry[];
	/** The new-session default — null when no strong slot is set (the turn
	 *  gate refuses with 503 models_not_configured). */
	defaults: ModelPin | null;
	/** The background roles' resolved pins (effectiveSettings()). */
	rolePins: RolePins;
	/** effectiveSettings().models verbatim. */
	slots: SlotPins;
	/** Every key-taking provider and whether its key is present; the picker
	 *  lists models from keyed providers only. */
	providers: CatalogProvider[];
}

export interface CatalogProvider {
	id: string;
	/** The env var whose presence makes this provider's models available. */
	envVar: string;
	/** Whether that var is currently present (env or auth file). */
	keyPresent: boolean;
}