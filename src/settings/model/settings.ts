/**
 * The user settings record's shape and factory defaults.
 *
 * Delta semantics (owner decision): the record stores explicit user choices
 * only — absent keys resolve to FACTORY_SETTINGS. Models are the exception
 * (BYOK, owner decision): no factory models exist, so an absent model key
 * resolves to empty and the per-need gates refuse. An update that adds a
 * knob needs no migration. The sanitizer lives in schema.ts; the resolved
 * view in resolution.ts.
 */

import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
import { AUTH_PROVIDER_KEYS } from "./auth-keys.ts";
import { CUSTOM_ENDPOINT_PROVIDER_ID, type CustomEndpointConfig } from "./custom-endpoint.ts";
import type { SearchEngineId } from "../../tools/model/index.ts";
import type { GraphRenderSettings } from "./graph-render.ts";

/** Every agent role in the app. The conversation pair (prober/teacher)
 *  resolves chat.model → strong slot; background roles resolve their own
 *  override → tier slot (ROLE_SLOT). */
export type ModelRole =
	| "prober"
	| "teacher"
	| "researcher"
	| "demoBuilder"
	| "visualMaker"
	| "pdfReader"
	| "extractor"
	| "auditor";

/** The schema version this code understands. Bump only for breaking shape
 *  changes (a field renamed/meaning changed); pure additions never bump.
 *  Unrelated to the app release version. */
export const CURRENT_SETTINGS_VERSION = 1;

/** The background-agent roles whose models the Agent settings expose.
 *  The conversation pair stays out — controlled by the model picker. */
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

/** The capability tiers a user pins models into (owner decision); see
 *  ROLE_SLOT for which role draws from which. Strong is also the
 *  new-session default. */
export const MODEL_SLOTS = ["strong", "cheap", "vision"] as const;
export type ModelSlotName = (typeof MODEL_SLOTS)[number];

/** The default for unset thinking levels only (owner decision): a model
 *  with no level resolves to the first entry here the model supports.
 *  Explicitly set levels never consult this list — they clamp to the
 *  nearest supported level. The UI also uses it to pre-fill a level on a
 *  fresh model pick. */
export const DEFAULT_THINKING_ORDER = [
	"medium",
	"low",
	"high",
	"minimal",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];

/** The not-configured refusal envelope: every per-need gate (turn, job
 *  spawn, notes import) refuses with this exact shape. HTTP callers get
 *  503 + this JSON; in-band consumers (a job record's error) carry the
 *  human `error` line. */
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
 *  catch it to skip (trigger) or surface the 503 envelope (routes). */
export class ModelsNotConfiguredError extends Error {
	readonly envelope: ModelsNotConfigured;
	constructor(missing: ModelSlotName[]) {
		super(modelsNotConfigured(missing).error);
		this.name = "ModelsNotConfiguredError";
		this.envelope = modelsNotConfigured(missing);
	}
}

/** The key-presence refusal: a pinned model is not enough — without its
 *  provider's key the action dies mid-stream with a generic error. Same
 *  envelope family and transport as modelsNotConfigured. */
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
/** The ProviderKeyMissing sibling of ModelsNotConfiguredError. */
export class ProviderKeyMissingError extends Error {
	readonly envelope: ProviderKeyMissing;
	constructor(provider: string, slots: ModelSlotName[]) {
		const envelope = providerKeyMissing(provider, slots);
		super(envelope.error);
		this.name = "ProviderKeyMissingError";
		this.envelope = envelope;
	}
}

/** The `models` settings section (owner decision: slots are app-level
 *  choices, not one session's). An absent slot leaves its tier's roles
 *  with only their per-role overrides. */
export type ModelsSettings = Partial<Record<ModelSlotName, ModelChoice>>;

/** First-run gate (owner decision): the app refuses to start chats until
 *  the user has picked a model for every slot. Thinking levels stay
 *  optional. */
export function slotsConfigured(models: ModelsSettings | undefined): boolean {
	return Boolean(models?.strong?.model && models?.cheap?.model && models?.vision?.model);
}

/** Which slot a role draws from (owner decision). Spans every role; only
 *  BackgroundModelRoles surface per-role overrides. */
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
	/** Background-role model/thinking overrides (absent role = its slot). */
	models?: Partial<Record<BackgroundModelRole, ModelChoice>>;
	/** Tool toggles keyed by tool id (absent key = enabled). User-level
	 *  only — no per-chat override (owner decision). */
	tools?: Record<string, boolean>;
	/** Search-engine preference, optional (owner decision): setting a key
	 *  activates its engine. An explicit choice only pins the preference
	 *  (e.g. when both keys are present); the chosen engine must still have
	 *  its key, else search is unavailable — no silent fallback. */
	search?: { engine?: SearchEngineId };
	/** Prober graph tools: read-only knowledge-graph views for the prober.
	 *  Absent = enabled; the effective gate is graph.enabled AND this switch. */
	graphTools?: { enabled?: boolean };
	/** System-prompt override switches keyed by segment path (absent key =
	 *  off). Switch-on requires the override file to exist; the switch is
	 *  explicit so users can keep a file on disk but run the source default
	 *  to compare (owner decision). */
	prompts?: Record<string, boolean>;
}

/** Markdown-rendering knobs — the bare-bones set (owner decision). */
interface MdRenderingSettings {
	/** Heading font weight (100–900, default 900). CSS resolves the nearest
	 *  available weight of the chosen font — no font introspection needed. */
	headingWeight?: number;
	/** Color for **bold** spans (null = same as text). */
	boldColor?: string | null;
	/** Color for *italic* spans (null = same as text). */
	italicColor?: string | null;
}

/** Appearance settings — mode, colors, type, markdown emphasis. */
export interface AppearanceSettings {
	/** "dark" | "light" (default dark). */
	mode?: "dark" | "light";
	/** The one user-chosen color; everything else derives per-mode in code.
	 *  null = the mode's default background. */
	background?: string | null;
	/** The main reading font by name, chosen from installed fonts.
	 *  null = Source Sans 3. */
	fontFamily?: string | null;
	/** Reading font size in px (12–24, default 16). Headings render as
	 *  multiples of this, so one knob scales the document coherently. */
	proseFontSize?: number;
	/** Session names in CMU Serif (default true). */
	sessionNameSerif?: boolean;
	mdRendering?: MdRenderingSettings;
}

/** Knowledge-graph settings. */
export interface GraphSettings {
	/** The data switch: off = no extraction, no auditor. Stored data stays. */
	enabled?: boolean;
	/** A display switch only: off = the home shows the chains view instead
	 *  of the graph canvas. Default on. */
	rendering?: boolean;
	/** The chunk budget: a run fires when a chat's uncovered transcript
	 *  tokens reach it, and batches the oldest uncovered messages into runs
	 *  of ≤ this many tokens. Every run also carries the whole graph +
	 *  instructions, so a smaller budget means more runs each paying that
	 *  overhead. Floor EXTRACTION_CHUNK_TOKENS_FLOOR (below it, batches cost
	 *  more than they extract); no ceiling on purpose — a large budget just
	 *  delays extraction. */
	extractionChunkTokens?: number;
}

/**
 * Compaction's one knob: the trigger threshold in context tokens. The
 * effective trigger is min(this, model contextWindow − reserve) (owner
 * decision). Floor COMPACTION_THRESHOLD_FLOOR: below the kept tail + a
 * summary, the chat would re-compact every turn. No ceiling.
 */
export interface CompactionSettings {
	thresholdTokens?: number;
}

/** The record. Every section optional (delta); unknown top-level keys are
 *  preserved verbatim by the sanitizer (forward-compat with newer records). */
export interface UserSettings {
	version: number;
	agent?: AgentSettings;
	models?: ModelsSettings;
	/** The optional custom OpenAI Responses endpoint. Its API key lives in
	 *  auth.json, never in this record. */
	customEndpoint?: CustomEndpointConfig;
	appearance?: AppearanceSettings;
	graph?: GraphSettings;
	compaction?: CompactionSettings;
	/** The graph view's render and physics sliders. */
	graphRender?: GraphRenderSettings;
	[key: string]: unknown;
}

/** Factory defaults (owner decisions). No factory models exist (BYOK):
 *  every slot stays empty until the user picks. Tools default on and
 *  prompt overrides off — hence their absence here. */
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

/** The chunk budget's floor: the PUT rejects below it, the sanitizer
 *  clamps to it. */
export const EXTRACTION_CHUNK_TOKENS_FLOOR = 500;

/** The compaction threshold's floor (see CompactionSettings). */
export const COMPACTION_THRESHOLD_FLOOR = 32_000;

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
