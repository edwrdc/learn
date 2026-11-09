/**
 * THE SETTINGS RESOLUTION LAYER (settings-storage wave, 2026-09-19): pure
 * projection of the delta record (core/settings.ts UserSettings) into
 * EffectiveSettings — every field CONCRETE, ready for consumers with no
 * delta-walking of their own.
 *
 * Resolution rule (owner decision): explicit value in the record wins;
 * absent key resolves to the compiled factory default — EXCEPT MODELS
 * (BYOK all the way down, owner 2026-09-22): no factory pins exist, so a
 * model chain that ends empty resolves to null/undefined and whatever
 * needs it refuses honestly (503 models_not_configured). This module
 * stays browser-safe/pure, so it imports config TYPES only, never the
 * runtime module (config.ts pulls node:path).
 *
 * Deliberately NOT resolved here (see settings.ts module doc):
 * - per-chat overrides: the chat record's ChatSettings applies via the
 *   conversation chain in chat-handler (chat.model → strong slot) — prober
 *   and teacher stay chat-controlled, never settings-record-controlled;
 * - tool toggles: passed through as the delta map; consumers look up by
 *   tool id with absent → enabled (the honoring lives in the agent band);
 * - prompt switches: passed through; effective composition lives in
 *   src/store/prompt-overrides.ts (segment list derived from source).
 */

import { DEFAULT_RENDER_SETTINGS, type GraphRenderSettings } from "../../graph/model/index.ts";
import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
import type { SearchEngineId } from "../../tools/model/index.ts";
import {
	BACKGROUND_MODEL_ROLES,
	FACTORY_SETTINGS,
	MODEL_SLOTS,
	ROLE_SLOT,
	type AgentSettings,
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

/** The concrete appearance view — same shape as the factory's. */
export type EffectiveAppearance = FactorySettings["appearance"];

/** The concrete view: every knob resolved, no absent fields. */
export interface EffectiveSettings {
	agent: {
		models: Record<BackgroundModelRole, EffectiveModelSpec | undefined>;
		/** Delta map as stored — consumers resolve absent key → enabled. */
		tools: Record<string, boolean>;
		/** Delta map as stored — absent key → override off. */
		prompts: Record<string, boolean>;
		/** The search-engine preference as stored (search wave, 2026-09-20):
		 *  passthrough delta — engine resolution (pin → auto → unavailable)
		 *  lives in server/search.ts, where keys are visible. */
		search: { engine?: SearchEngineId };
		/** Prober graph tools (wave 7): passthrough delta as stored —
		 * absent/undefined enabled = ON; consumers use graphToolsEnabled. */
		graphTools: { enabled?: boolean };
	};
	/** The resolved strong/cheap/vision slots: each tier's concrete model or
	 *  NULL when the tier holds no model (no factory floor — BYOK all the
	 *  way down, owner 2026-09-22). These are the tier-level views the
	 *  picker captions and the per-need refusal gates read. */
	models: Record<ModelSlotName, EffectiveModelSpec | null>;
	appearance: EffectiveAppearance;
	graph: Required<GraphSettings>;
	/** Compaction (owner round 14): resolved concrete — absent record
	 *  section resolves to the factory 150k. */
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

/** The conversation pair's chain (BYOK, owner 2026-09-22): the chat's own
 *  settings over the STRONG slot. null = no model anywhere — the turn gate
 *  refuses with the models_not_configured envelope. */
export function resolveConversationSpec(chat: ModelChoice | undefined, strong: EffectiveModelSpec | null): EffectiveModelSpec | null {
	const base = strong ? { model: { provider: strong.provider, id: strong.id }, thinkingLevel: strong.thinkingLevel } : undefined;
	return overlay(chat, base) ?? null;
}

/** One role's chain (BYOK, owner 2026-09-22): its override (background
 *  roles only) → its SLOT → nothing. undefined = the chain came up empty;
 *  the per-need refusal gates fire on exactly that. */
export function resolveRoleSpec(role: ModelRole, record: UserSettings | null): EffectiveModelSpec | undefined {
	const override = (BACKGROUND_MODEL_ROLES as readonly string[]).includes(role)
		? record?.agent?.models?.[role as BackgroundModelRole]
		: undefined;
	return overlay(override, record?.models?.[ROLE_SLOT[role]]);
}

/** Resolve the whole record. `record` may be null (first boot) — every
 *  factory-defaulted field lands on its default; MODEL fields resolve to
 *  null/undefined when unset (no factory pins exist — BYOK all the way
 *  down, owner 2026-09-22). */
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
			// Wave 7 collapse (owner ruling 2026-09-23): the master switch ONLY —
			// the embedding/clustering/labeling rungs and the BYOK embeddingModel
			// are gone (stale record keys are simply never read here).
			enabled: graph.enabled ?? FACTORY_SETTINGS.graph.enabled,
			// The RENDERING switch (owner, 2026-10-06): display-only — gates
			// the home's main view (canvas vs chains), never the data.
			rendering: graph.rendering ?? FACTORY_SETTINGS.graph.rendering,
			// The chunk budget (extraction-UX redesign, 2026-09-24): absent
			// (pre-redesign record, fresh install) resolves to the factory
			// 4096; the sanitizer has already clamped/floored any stored value.
			extractionChunkTokens: graph.extractionChunkTokens ?? FACTORY_SETTINGS.graph.extractionChunkTokens,
		},
		compaction: {
			thresholdTokens: record?.compaction?.thresholdTokens ?? FACTORY_SETTINGS.compaction.thresholdTokens,
		},
		graphRender: record?.graphRender ?? DEFAULT_RENDER_SETTINGS,
	};
}

// ─── Graph channel gates (the settings wave's seam honoring) ─────────────────

/**
 * The PROBER GRAPH TOOLS gate (wave 7, owner ruling 2026-09-23): the
 * toggle is an agent-capability switch (it gates tool registration), but
 * the tools only mean anything when the graph itself runs — so the
 * effective gate composes the graph master switch AND the toggle.
 * Teacher's tool factories consume this at registration time.
 */
export function graphToolsEnabled(effective: {
	graph: { enabled: boolean };
	agent: { graphTools: { enabled?: boolean } };
}): boolean {
	return effective.graph.enabled && (effective.agent.graphTools.enabled ?? true);
}


