/**
 * Projects the delta record (UserSettings) into EffectiveSettings — every
 * field concrete, so consumers never walk the delta themselves.
 *
 * Resolution rule (owner decision): an explicit value in the record wins;
 * an absent key resolves to the factory default — except models (BYOK): a
 * model chain that ends empty resolves to null/undefined and whatever needs
 * it refuses (503 models_not_configured).
 *
 * Deliberately not resolved here:
 * - per-chat models: resolveConversationSpec applies the chat's own
 *   settings over the strong slot;
 * - tool toggles and prompt switches: passed through as delta maps (absent
 *   tool → enabled; prompt composition lives in src/session/prompts.ts).
 */

import { DEFAULT_RENDER_SETTINGS, type GraphRenderSettings } from "./graph-render.ts";
import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
import type { SearchEngineId } from "../../tools/model/index.ts";
import {
	BACKGROUND_MODEL_ROLES,
	FACTORY_SETTINGS,
	MODEL_SLOTS,
	ROLE_SLOT,
	type BackgroundModelRole,
	type ModelRole,
	type FactorySettings,
	type CompactionSettings,
	type GraphSettings,
	type ModelSlotName,
	type ModelChoice,
	type UserSettings,
} from "./settings.ts";

/** A resolved model pin: a configured slot, or one role's whole chain.
 *  An unset level is legal — the engine build picks the first entry of
 *  DEFAULT_THINKING_ORDER the model supports. */
export interface EffectiveModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

type EffectiveAppearance = FactorySettings["appearance"];

/** The concrete view: every knob resolved, no absent fields. */
export interface EffectiveSettings {
	agent: {
		models: Record<BackgroundModelRole, EffectiveModelSpec | undefined>;
		/** Delta map as stored — consumers resolve absent key → enabled. */
		tools: Record<string, boolean>;
		/** Delta map as stored — absent key → override off. */
		prompts: Record<string, boolean>;
		/** The search-engine preference as stored; engine resolution lives in
		 *  src/settings/search.ts, where keys are visible. */
		search: { engine?: SearchEngineId };
		/** Passthrough delta; consumers use graphToolsEnabled. */
		graphTools: { enabled?: boolean };
	};
	/** Each slot's concrete model, or null when the slot holds none. */
	models: Record<ModelSlotName, EffectiveModelSpec | null>;
	appearance: EffectiveAppearance;
	graph: Required<GraphSettings>;
	compaction: Required<CompactionSettings>;
	graphRender: GraphRenderSettings;
}

/** `top` over `base`, each field independent; undefined when neither names
 *  a model (a level alone cannot run). */
function overlay(top: ModelChoice | undefined, base: ModelChoice | undefined): EffectiveModelSpec | undefined {
	const model = top?.model ?? base?.model;
	if (!model) return undefined;
	return { provider: model.provider, id: model.id, thinkingLevel: top?.thinkingLevel ?? base?.thinkingLevel };
}

/** The conversation pair's chain: the chat's own settings over the strong
 *  slot. null = no model anywhere — the turn gate refuses with the
 *  models_not_configured envelope. */
export function resolveConversationSpec(chat: ModelChoice | undefined, strong: EffectiveModelSpec | null): EffectiveModelSpec | null {
	const base = strong ? { model: { provider: strong.provider, id: strong.id }, thinkingLevel: strong.thinkingLevel } : undefined;
	return overlay(chat, base) ?? null;
}

/** One role's chain: its override (background roles only) → its slot →
 *  nothing. undefined = the chain came up empty; the per-need refusal gates
 *  fire on exactly that. */
export function resolveRoleSpec(role: ModelRole, record: UserSettings | null): EffectiveModelSpec | undefined {
	const override = (BACKGROUND_MODEL_ROLES as readonly string[]).includes(role)
		? record?.agent?.models?.[role as BackgroundModelRole]
		: undefined;
	return overlay(override, record?.models?.[ROLE_SLOT[role]]);
}

/** Resolve the whole record. `record` is null on first boot. */
export function resolveSettings(record: UserSettings | null): EffectiveSettings {
	const agent = record?.agent ?? {};
	const modelsSection = record?.models ?? {};
	const appearance = record?.appearance ?? {};
	const md = appearance.mdRendering ?? {};
	const graph = record?.graph ?? {};
	const factoryAppearance = FACTORY_SETTINGS.appearance;
	const factoryMd = factoryAppearance.mdRendering;
	const models = {} as Record<BackgroundModelRole, EffectiveModelSpec | undefined>;
	for (const role of BACKGROUND_MODEL_ROLES) models[role] = overlay(agent.models?.[role], modelsSection[ROLE_SLOT[role]]);
	const slots = {} as Record<ModelSlotName, EffectiveModelSpec | null>;
	for (const slot of MODEL_SLOTS) slots[slot] = overlay(undefined, modelsSection[slot]) ?? null;
	return {
		agent: {
			models,
			tools: agent.tools ?? {},
			prompts: agent.prompts ?? {},
			search: agent.search ?? {},
			graphTools: agent.graphTools ?? {},
		},
		models: slots,
		appearance: {
			mode: appearance.mode ?? factoryAppearance.mode,
			background: appearance.background ?? factoryAppearance.background,
			fontFamily: appearance.fontFamily ?? factoryAppearance.fontFamily,
			proseFontSize: appearance.proseFontSize ?? factoryAppearance.proseFontSize,
			sessionNameSerif: appearance.sessionNameSerif ?? factoryAppearance.sessionNameSerif,
			mdRendering: {
				headingWeight: md.headingWeight ?? factoryMd.headingWeight,
				boldColor: md.boldColor ?? factoryMd.boldColor,
				italicColor: md.italicColor ?? factoryMd.italicColor,
			},
		},
		graph: {
			enabled: graph.enabled ?? FACTORY_SETTINGS.graph.enabled,
			rendering: graph.rendering ?? FACTORY_SETTINGS.graph.rendering,
			extractionChunkTokens: graph.extractionChunkTokens ?? FACTORY_SETTINGS.graph.extractionChunkTokens,
		},
		compaction: {
			thresholdTokens: record?.compaction?.thresholdTokens ?? FACTORY_SETTINGS.compaction.thresholdTokens,
		},
		graphRender: record?.graphRender ?? DEFAULT_RENDER_SETTINGS,
	};
}

/** The prober graph tools only mean anything when the graph itself runs,
 *  so the effective gate composes the graph switch and the toggle. */
export function graphToolsEnabled(effective: {
	graph: { enabled: boolean };
	agent: { graphTools: { enabled?: boolean } };
}): boolean {
	return effective.graph.enabled && (effective.agent.graphTools.enabled ?? true);
}


