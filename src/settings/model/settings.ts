/**
 * THE USER SETTINGS RECORD's shape + sanitizer (settings-storage wave,
 * 2026-09-19): one versioned, DELTA-shaped record at the data-dir seam
 * (config.SETTINGS_FILE) holding every non-secret product preference.
 *
 * DELTA SEMANTICS (owner decision, 2026-09-19): the record stores EXPLICIT
 * user choices only — ABSENT keys resolve to the factory defaults compiled
 * into this module (FACTORY_SETTINGS). MODELS are the exception (owner,
 * 2026-09-22 — BYOK all the way down): no factory pins exist, so an absent
 * model key resolves to EMPTY and the per-need gates refuse honestly. A
 * software update that ADDS a knob (new
 * tool, new role, new appearance field) therefore needs no migration: old
 * records simply lack the new keys. `version` is a PRIVATE schema counter
 * for BREAKING shape changes only (field renamed / meaning changed) —
 * unrelated to the app release version. Migrations live in the adapter
 * (src/store/settings.ts), not here.
 *
 * Sanitizer contract (mirrors render-settings.ts discipline): whatever
 * arrives from disk or the network passes through sanitizeUserSettings
 * before use — never trusted raw. Strict on known fields, PRESERVES
 * unknown TOP-LEVEL keys verbatim (a newer record must never be destroyed
 * by an older app reading it); a known section is rebuilt from its known
 * fields only, so unknown sub-keys inside it drop. Invalid known values
 * degrade gracefully: out-of-range numbers CLAMP, wrong-typed/invalid
 * fields DROP (resolve to factory default), never throw.
 *
 * Browser-safe: pure logic + types only, no node imports. The resolved
 * (fully concrete) view lives in settings-resolution.ts.
 */

import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
import { AUTH_PROVIDER_KEYS } from "./auth-keys.ts";
import { CUSTOM_ENDPOINT_PROVIDER_ID, type CustomEndpointConfig } from "./custom-endpoint.ts";
import type { SearchEngineId } from "../../tools/model/index.ts";
import type { GraphRenderSettings } from "../../graph/model/index.ts";

/** Every agent role in the app. The conversation pair (prober/teacher)
 *  resolves chat.model → strong slot; background roles resolve their own
 *  override → tier slot (core/settings-resolution.ts ROLE_SLOT). */
export type ModelRole =
	| "prober"
	| "teacher"
	| "researcher"
	| "demoBuilder"
	| "visualMaker"
	| "pdfReader"
	| "extractor"
	| "auditor";

/** The schema version this code understands. Bump ONLY for breaking shape
 *  changes (a field renamed/meaning changed); pure additions never bump. */
export const CURRENT_SETTINGS_VERSION = 1;

/** The background-agent roles whose models the Agent settings expose.
 *  The conversation pair (prober/teacher) stays out — chat-controlled via
 *  the strong slot (one controller, the model picker). Tests pin the set. */
export const BACKGROUND_MODEL_ROLES = [
	"researcher",
	"demoBuilder",
	"visualMaker",
	"extractor",
	"auditor",
] as const;

export type BackgroundModelRole = (typeof BACKGROUND_MODEL_ROLES)[number];

/** A model pick — a chat's own settings, a slot, or a background role's
 *  override. Each field is independent; an absent one falls back along the
 *  resolution chain. */
export interface ModelChoice {
	/** Both coordinates or neither. */
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
}

// ─── Model slots (model slots wave, 2026-09-20) ──────────────────────────────

/** The capability tiers a user can pin models into (owner-settled mapping):
 *  strong = prober + teacher (also the per-session default-teacher
 *  starting point); cheap = researcher, demo-builder, extractor, auditor,
; vision = visual-maker + pdf-reader. Resolution per role:
 *  ROLE OVERRIDE → slot → factory pin. */
export const MODEL_SLOTS = ["strong", "cheap", "vision"] as const;
export type ModelSlotName = (typeof MODEL_SLOTS)[number];

/** The DEFAULT thinking level for UNSET levels only (owner, 2026-09-22):
 *  a slot/override/chat that names a model but no thinking level resolves
 *  to the FIRST entry in this order that the model supports
 *  (getSupportedThinkingLevels); a non-reasoning model resolves "off"
 *  regardless (pi reports exactly ["off"]). EXPLICITLY set levels never
 *  consult this list — they clamp nearest via pi's native
 *  clampThinkingLevel on model switches.
 *
 *  Client surface (interlude, 2026-09-22): this constant lives in the CORE
 *  BARREL — the UI imports it to auto-populate a thinking level on a FRESH
 *  model pick (one source of truth, AUTH_KEYS precedent; per-model
 *  supportedLevels already reach the client via the catalog). The ordering
 *  has NO other client role: legacy unset records keep the runtime
 *  defaultThinkingLevel fallback at engine build. */
export const DEFAULT_THINKING_ORDER = [
	"medium",
	"low",
	"high",
	"minimal",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];

/** The machine-readable NOT-CONFIGURED refusal envelope (owner, 2026-09-22):
 *  every per-need gate — the turn gate in chat-handler, a job spawn, a
 *  notes import — refuses with this exact shape. HTTP callers get 503 +
 *  this JSON; in-band consumers (the job record's error field) carry the
 *  human `error` line. `missing` names the slot TIER(S) the refused
 *  action needs and found unset. */
export const MODELS_NOT_CONFIGURED_CODE = "models_not_configured" as const;
export interface ModelsNotConfigured {
	/** Human-readable — safe to render as-is. */
	error: string;
	/** The machine discriminator the client switches on. */
	code: typeof MODELS_NOT_CONFIGURED_CODE;
	/** Which slot tiers the refused action needs ("strong" | "cheap" | "vision"). */
	missing: ModelSlotName[];
}
export function modelsNotConfigured(missing: ModelSlotName[]): ModelsNotConfigured {
	return {
		error: "No model configured — set up your models first",
		code: MODELS_NOT_CONFIGURED_CODE,
		missing,
	};
}

/** The typed throw for in-process seams (extraction pipeline): callers
 *  catch it to skip honestly (trigger) or surface the 503 envelope
 *  (routes) instead of logging a failure. */
export class ModelsNotConfiguredError extends Error {
	readonly envelope: ModelsNotConfigured;
	constructor(missing: ModelSlotName[]) {
		super(modelsNotConfigured(missing).error);
		this.name = "ModelsNotConfiguredError";
		this.envelope = modelsNotConfigured(missing);
	}
}

/** The key-presence refusal (provider-key interlude, owner, 2026-09-25):
 * a PINNED model is not enough — its provider's key must be present, or
 * the action dies mid-stream masked to a generic error. Same envelope
 * family as modelsNotConfigured: HTTP callers get 503 + this JSON;
 * in-band consumers (the job record's error field) carry the human
 * `error` line. `provider` names whose key is gone; `slots` names the
 * slot tier(s) the refused action resolves to that provider. */
export const PROVIDER_KEY_MISSING_CODE = "provider_key_missing" as const;
export interface ProviderKeyMissing {
	/** Human-readable — safe to render as-is. */
	error: string;
	/** The machine discriminator the client switches on. */
	code: typeof PROVIDER_KEY_MISSING_CODE;
	/** The provider whose key is gone, e.g. "openrouter". */
	provider: string;
	/** Which slot tiers the refused action resolves to that provider. */
	slots: ModelSlotName[];
}
const PROVIDER_KEY_MISSING_TAIL = "key is set — add one in Settings → Keys";
export function providerKeyMissing(provider: string, slots: ModelSlotName[]): ProviderKeyMissing {
	const label =
		provider === CUSTOM_ENDPOINT_PROVIDER_ID
			? "custom endpoint"
			: (AUTH_PROVIDER_KEYS.find((p) => p.id === provider)?.label ?? provider);
	return {
		error: `No ${label} ${PROVIDER_KEY_MISSING_TAIL}`,
		code: PROVIDER_KEY_MISSING_CODE,
		provider,
		slots,
	};
}
/** Why a piece of work was refused before it ran (the envelopes' codes). */
export type RefusalCode = typeof MODELS_NOT_CONFIGURED_CODE | typeof PROVIDER_KEY_MISSING_CODE;
/** The typed throw for in-process seams (extraction pipeline) — the
 * ProviderKeyMissing sibling of ModelsNotConfiguredError: callers catch
 * it to skip honestly (trigger) or surface the 503 envelope (routes). */
export class ProviderKeyMissingError extends Error {
	readonly envelope: ProviderKeyMissing;
	constructor(provider: string, slots: ModelSlotName[]) {
		const envelope = providerKeyMissing(provider, slots);
		super(envelope.error);
		this.name = "ProviderKeyMissingError";
		this.envelope = envelope;
	}
}

/** The `models` settings section (owner decision 2026-09-20: a dedicated
 *  section — slots are engine-level choices, not one session's). All slots
 *  optional: an absent slot means every role of its tier runs whatever the
 *  deeper tiers of the chain resolve to (per-role override → factory pin). */
export type ModelsSettings = Partial<Record<ModelSlotName, ModelChoice>>;

/** First-run gate (model-slots wave, owner 2026-09-20): the app refuses
 *  to start chats until the user has actively picked all three slots —
 *  there ARE no defaults for 33 providers; a configured app is one whose
 *  models section carries a model in every slot. Thinking levels stay
 *  optional (absent = the resolved tier's budget). */
export function slotsConfigured(models: ModelsSettings | undefined): boolean {
	return Boolean(models?.strong?.model && models?.cheap?.model && models?.vision?.model);
}

/** Which slot a role draws from (model slots wave, 2026-09-20). Includes the
 *  conversation pair and pdfReader (not BackgroundModelRoles — the slot
 *  tier spans every role; only background roles surface per-role overrides). */
export const ROLE_SLOT: Readonly<Record<ModelRole, ModelSlotName>> = {
	prober: "strong",
	teacher: "strong",
	researcher: "cheap",
	demoBuilder: "cheap",
	extractor: "cheap",
	auditor: "cheap",
	visualMaker: "vision",
	pdfReader: "vision",
};

/** Agent settings — everything about the non-conversation machinery. */
export interface AgentSettings {
	/** Background-role model/thinking overrides (absent role = config pin). */
	models?: Partial<Record<BackgroundModelRole, ModelChoice>>;
	/** Tool toggles keyed by tool id (absent key = enabled). User-level
	 *  only — no per-chat override (owner decision 2026-09-19). */
	tools?: Record<string, boolean>;
	/** Search-engine preference (search wave, 2026-09-20). OPTIONAL by
	 *  owner decision: setting a key auto-activates its engine — the user
	 *  never chooses an engine to make search work. An explicit choice only
	 *  pins the preference (e.g. when BOTH keys are present); the chosen
	 *  engine must still have its key, else search is honestly unavailable.
	 *  Absent + no key = unavailable (no silent fallback, no default). */
	search?: { engine?: SearchEngineId };
	/** Prober graph tools (wave 7, owner ruling 2026-09-23): read-only
	 *  knowledge-graph views for the prober agent — a session list +
	 *  per-session propositions with understanding levels. Its SUBJECT
	 *  is the graph but its MECHANISM is agent capability (tool
	 *  registration), so it lives here in its OWN subsection, not in the
	 *  tool-toggles map. Absent = enabled (the toggle discipline); the
	 *  effective gate composes graph.enabled AND this switch. */
	graphTools?: { enabled?: boolean };
	/** System-prompt override SWITCHES keyed by segment path (absent key =
	 *  off). Switch-on requires the override file to exist (enforced by the
	 *  route); the switch is explicit so users keep a file on disk but run
	 *  the source default to compare (owner decision 2026-09-19). */
	prompts?: Record<string, boolean>;
}

/** Markdown-rendering knobs — the bare-bones set (owner decision). */
export interface MdRenderingSettings {
	/** Heading font weight (100–900, default 900). CSS resolves the nearest
	 *  available weight of the chosen font — no font introspection needed. */
	headingWeight?: number;
	/** Color for **bold** spans (default #ffffff). */
	boldColor?: string | null;
	/** Color for *italic* spans (default #ffffff). */
	italicColor?: string | null;
}

/** Appearance settings — mode, colors, type, markdown emphasis. */
export interface AppearanceSettings {
	/** "dark" | "light" (default dark). */
	mode?: "dark" | "light";
	/** The one user-chosen color; everything else derives per-mode in code.
	 *  null = the mode's default background. */
	background?: string | null;
	/** The main reading font (everything that is Source Sans 3 today), by
	 *  name — user-chosen from installed fonts. null = Source Sans 3. */
	fontFamily?: string | null;
	/** Reading font size in px (12–24, default 16). Headings render as
	 *  multiples of this, so one knob scales the document coherently. */
	proseFontSize?: number;
	/** Session names in CMU Serif (default true — today's look). */
	sessionNameSerif?: boolean;
	mdRendering?: MdRenderingSettings;
}

/** Knowledge-graph settings — a strict dependency ladder (owner decision
 *  2026-09-19): graph → embedding → clustering → labeling, each rung only
 *  meaningful when its parent is on (the UI grays dependents out; stored
 *  values persist but resolve inert). All default true. */
export interface GraphSettings {
	/** MASTER (and, since wave 7, ONLY): off = no extraction, no auditor.
	 *  The wave-7 collapse (owner ruling 2026-09-23) deleted the three
	 *  subordinate rungs — embedding/clustering/labeling — and the BYOK
	 *  embeddingModel: clustering is the free birth-session partition
	 *  derived on read (core/session-clusters.ts), labels ARE session
	 *  names, and the prober graph tools read the ledgers directly — there
	 *  is nothing left to configure. Data stays stored either way. */
	enabled?: boolean;
	/** GRAPH RENDERING (owner, 2026-10-06 — the release graph-controls
	 *  round): gates ONLY the home's main view. Off = the home shows the
	 *  chains view instead of the canvas; the ledgers, the extraction
	 *  pipeline, and every write path are untouched — this is a display
	 *  switch, not a data switch (the extraction master above is the
	 *  data switch). Default on. */
	rendering?: boolean;
	/** The chunk budget (extraction-UX redesign, owner 2026-09-24): the
	 *  transcript-token share of the extractor's context — a run fires
	 *  when a chat's UNCOVERED tokens reach it, and the run batches the
	 *  oldest uncovered messages into runs of ≤ this many tokens. It
	 *  bounds both cost and chunk size (the extractor prompt also
	 *  carries the whole graph + instructions, so a smaller budget means
	 *  more, smaller runs — each paying that fixed overhead).
	 *
	 *  FACTORY DEFAULT 4096 (owner, 2026-10-13: halved back from the
	 *  digest-era 8192 — the labeled passages + message anchors made
	 *  smaller batches worth their overhead again; the pre-setting
	 *  constant was 4096, vision-extraction-coverage.md, 2026-09-15).
	 *  Only the FACTORY moves: an explicit user value always wins.
	 *
	 *  FLOOR 500 (EXTRACTION_CHUNK_TOKENS_FLOOR, the implementer's call
	 *  per the owner's dispatch): every run pays the graph-carrying
	 *  prompt overhead out of the write channel's money — a budget below
	 *  ~500 tokens would fire penny-batches that cost more per extracted
	 *  token than the content is worth, so the sanitizer clamps and the
	 *  PUT rejects below it. NO CEILING on purpose: a large budget just
	 *  delays extraction — the user's stated cost/thoroughness tradeoff,
	 *  not a misconfiguration to police. */
	extractionChunkTokens?: number;
}

/**
 * COMPACTION (owner round 14, 2026-10-05): the context-fitting mechanic's
 * user-facing knob. One number — the trigger threshold in context tokens.
 * The effective trigger is min(this, model contextWindow − 16k reserve)
 * (owner ruling: on big models the setting rules; on small ones the
 * window rules before the provider overflows).
 *
 * FACTORY DEFAULT 150_000 (owner ruling).
 *
 * FLOOR 32_000 (implementer's call, the chunk-budget discipline): below
 * the kept tail (20k) + a summary the chat would re-compact every turn —
 * a burn, not a preference. NO CEILING: a huge threshold just means "fit
 * everything" until the window rule binds.
 */
export interface CompactionSettings {
	thresholdTokens?: number;
}

/** THE record. Every section optional (delta); unknown top-level keys are
 *  preserved verbatim by the sanitizer (forward-compat with newer records). */
export interface UserSettings {
	version: number;
	agent?: AgentSettings;
	/** The strong/cheap/vision model slots (model slots wave, 2026-09-20). */
	models?: ModelsSettings;
	/** The ONE optional custom OpenAI Responses endpoint (custom-endpoint
	 *  wave): nonsecret display name, base URL, and explicitly configured
	 *  models. Its API key lives in auth.json, never in this record. */
	customEndpoint?: CustomEndpointConfig;
	appearance?: AppearanceSettings;
	graph?: GraphSettings;
	compaction?: CompactionSettings;
	/** The graph view's render and physics sliders. */
	graphRender?: GraphRenderSettings;
	[key: string]: unknown;
}

/** Factory defaults for everything core can pin (owner decisions
 *  2026-09-19). NO factory models exist anywhere (owner, 2026-09-22 — BYOK
 *  all the way down): the chat section and every slot stay empty until the
 *  user picks, and the per-need gates refuse honestly; tools default on;
 *  prompts default off — hence their absence here. */
export interface FactorySettings {
	version: number;
	appearance: {
		mode: "dark" | "light";
		background: string | null;
		fontFamily: string | null;
		proseFontSize: number;
		sessionNameSerif: boolean;
		mdRendering: {
			headingWeight: number;
			boldColor: string | null;
			italicColor: string | null;
		};
	};
	graph: Required<GraphSettings>;
	compaction: Required<CompactionSettings>;
}

export const FACTORY_SETTINGS: FactorySettings = {
	version: CURRENT_SETTINGS_VERSION,
	appearance: {
		mode: "dark",
		background: null, // the dark default (#141414) lives in the mode's derivation curve
		fontFamily: null, // Source Sans 3
		proseFontSize: 16,
		sessionNameSerif: true,
		mdRendering: { headingWeight: 900, boldColor: null, italicColor: null },
	},
	graph: { enabled: true, rendering: true, extractionChunkTokens: 4096 },
	compaction: { thresholdTokens: 150_000 },
};

/** The chunk budget's validated floor (GraphSettings.extractionChunkTokens
 *  — see its doc for the penny-batch rationale; the settings PUT names this
 *  in its rejection, the sanitizer clamps to it). */
export const EXTRACTION_CHUNK_TOKENS_FLOOR = 500;

/** The compaction threshold's floor (see CompactionSettings). */
export const COMPACTION_THRESHOLD_FLOOR = 32_000;

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
