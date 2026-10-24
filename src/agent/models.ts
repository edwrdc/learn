import {
	clampThinkingLevel,
	createModels,
	createProvider,
	getSupportedThinkingLevels,
	type Api,
	type Model,
	type Models,
	type Provider,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ModelRole } from "../../config.ts";
import { DEFAULT_THINKING_ORDER } from "../core/settings.ts";
import {
	CUSTOM_ENDPOINT_PROVIDER_ID,
	type CustomEndpointConfig,
} from "../core/custom-endpoint.ts";
import packageMetadata from "../../package.json" with { type: "json" };

/** App identity is immutable and shared by Models and every native Agent.
 * Agent's default Pi attribution otherwise overrides the Models identity. */
export const APP_IDENTITY = Object.freeze({
	userAgent: Object.freeze({ custom: `learnharness/${packageMetadata.version}` }),
	attribution: Object.freeze({ name: packageMetadata.name, url: packageMetadata.homepage }),
});

/**
 * The one engine factory every agent's model comes from (the pi-ai swap,
 * docs/pi-engine-swap.md). BYOK ALL THE WAY DOWN (owner, 2026-09-22):
 * there are no factory pins — every engine resolves from a RESOLVED SPEC
 * (the settings chain's output) and the one builder here wires it to
 * pi-ai's federated catalogs.
 *
 * An "engine" is the model + the stream function the agent loop runs on —
 * the two things a test fake replaces. Production engines resolve the model
 * from pi-ai's static catalogs and stream through the same Models
 * collection.
 */

export interface PiEngine {
	model: Model<Api>;
	streamFn: StreamFunction;
	/** The resolved (config-or-settings, CLAMPED) thinking level —
	 *  observability + tests; the streamFn pins it anyway. */
	level?: ThinkingLevel;
}

export type { ThinkingLevel };

let collection: ReturnType<typeof createModels> | undefined;

/** The process-wide pi-ai Models collection — EVERY builtin provider's
 *  catalog (model slots wave, 2026-09-20): engines and the picker resolve
 *  against all of pi-ai's per-provider catalogs, so a settings slot can pin
 *  any native model id. Auth is resolved per request by pi-ai itself from
 *  the environment (the keys seam reflects file-saved keys into env), and
 *  a provider with no key simply fails its stream with "not configured" —
 *  honest, late, and unreachable through the picker, which gates on
 *  keyPresent. */
export function piModels() {
	if (!collection) {
		collection = createModels({ identity: APP_IDENTITY });
		for (const provider of builtinProviders()) collection.setProvider(provider);
	}
	return collection;
}

/** OpenRouter API key (BYOK); tests never read this — they inject engines. */
export function openRouterApiKey(): string | undefined {
	return process.env.OPENROUTER_API_KEY || undefined;
}

interface CustomProviderSnapshot {
	config: CustomEndpointConfig;
	provider: Provider;
	apiKey: string | undefined;
}

let customSnapshot: CustomProviderSnapshot | undefined;

/**
 * Register (or remove) THE user-configured OpenAI Responses provider in the
 * process-wide collection. Called by the server composition boundary from
 * the settings record — the agent layer never reads the store itself.
 *
 * The provider is rebuilt on every config/key signature change, so saved
 * edits reach the catalog immediately. Static model entries carry the
 * explicit limits/capabilities from the settings record; their numeric
 * pi-ai costs are placeholders on purpose — the app's money channel reads
 * core/prices.ts, where this provider is absent, so prices stay UNPRICED
 * (never a fabricated zero) on every user-facing surface.
 *
 * `apiKey` is the key already resolved for this exact base URL by the
 * server composition. Capturing it here (instead of an env lookup at
 * request time) is what makes an engine's endpoint + credential immutable
 * across later edits/removals. */
export function setCustomEndpointProvider(config: CustomEndpointConfig | null, apiKey?: string): void {
	const models = piModels();
	if (!config) {
		customSnapshot = undefined;
		models.deleteProvider(CUSTOM_ENDPOINT_PROVIDER_ID);
		return;
	}
	const provider = createProvider({
		id: CUSTOM_ENDPOINT_PROVIDER_ID,
		name: config.displayName,
		baseUrl: config.baseUrl,
		auth: {
			apiKey: {
				name: "Custom endpoint API key",
				async resolve({ signal }) {
					signal.throwIfAborted();
					return apiKey ? { auth: { apiKey }, source: "custom endpoint key" } : undefined;
				},
			},
		},
		models: config.models.map((m): Model<"openai-responses"> => ({
			id: m.id,
			name: m.name,
			api: "openai-responses",
			provider: CUSTOM_ENDPOINT_PROVIDER_ID,
			baseUrl: config.baseUrl,
			reasoning: m.reasoning,
			input: m.imageInput ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		})),
		api: openAIResponsesApi(),
	});
	customSnapshot = { config, provider, apiKey };
	models.setProvider(provider);
}

/** Follow no redirects on a custom endpoint: the Authorization header must
 *  never be replayed to a different origin. Composes the caller's fetch (the
 *  test seam) when present. */
function noRedirectFetch(upstream: typeof fetch): typeof fetch {
	return (input, init) => upstream(input, { ...init, redirect: "error" });
}

/** A fully-resolved model pin — the shape every engine now comes from:
 *  the settings-resolution chain's output (role override → slot, or the
 *  chat's conversation chain). thinkingLevel is OPTIONAL: unset means
 *  the baked default resolves here (owner 2026-09-22) — the first entry
 *  of DEFAULT_THINKING_ORDER the model supports. */
export interface ResolvedModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

/** The first entry of the baked default order the model supports (owner,
 *  2026-09-22). A non-reasoning model reports exactly ["off"], so the
 *  order walk lands there naturally. */
function defaultThinkingLevel(model: Model<Api>): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

/** The production engine for a RESOLVED spec (model slots wave,
 *  2026-09-20): provider-aware catalog lookup + thinking clamp. Builtin
 *  engines resolve auth per request through the Models collection. A
 *  custom engine instead captures the published provider + credential at
 *  construction, so an edit/removal can never redirect an already-running
 *  turn (or swap its key mid-turn). New engines resolve the fresh config. */
export function piEngineForSpec(spec: ResolvedModelSpec): PiEngine {
	if (spec.provider === CUSTOM_ENDPOINT_PROVIDER_ID) {
		const snapshot = customSnapshot;
		const model = snapshot?.provider.getModels().find((m) => m.id === spec.id);
		if (!snapshot || !model) {
			throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
		}
		const level = spec.thinkingLevel
			? clampThinkingLevel(model, spec.thinkingLevel)
			: defaultThinkingLevel(model);
		const provider = snapshot.provider;
		const apiKey = snapshot.apiKey;
		return {
			model,
			level,
			streamFn: (requestModel, context, options) => {
				const upstream = options?.fetch ?? fetch;
				return provider.streamSimple(requestModel, context, {
					...options,
					apiKey,
					identity: options?.identity ?? APP_IDENTITY,
					reasoning: level === "off" ? undefined : level,
					fetch: noRedirectFetch(upstream),
				});
			},
		};
	}
	const models: Models = piModels();
	const model = models.getModel(spec.provider, spec.id);
	if (!model) {
		throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
	}
	// UNSET level → the baked default order (first entry the model
	// supports); SET level → pi's native nearest-clamp (model swaps keep
	// the user's intent and adapt honestly).
	const level = spec.thinkingLevel
		? clampThinkingLevel(model, spec.thinkingLevel)
		: defaultThinkingLevel(model);
	return {
		model,
		level,
		// bound streamSimple: the agent loop forwards state.thinkingLevel as
		// `reasoning` (undefined = off on pi-ai's scale); the clamp above keeps
		// the pin honest even when config or settings drift off the map.
		streamFn: (requestModel, context, options) =>
			models.streamSimple(requestModel, context, {
				...options,
				reasoning: level === "off" ? undefined : level,
			}),
	};
}

/** The LEGACY role entry point — BYOK made it an honest THROWER (owner,
 *  2026-09-22): no factory pins exist to fall back to, and this module
 *  cannot read settings (architecture law — the agent layer never
 *  imports the server layer). Production resolves the chain in
 *  chat-handler and ALWAYS injects engines; reaching this means a
 *  wiring bug, so it fails loudly instead of guessing a model. */
export function piEngineFor(role: ModelRole): PiEngine {
	throw new Error(
		`no configured model for role "${role}" — set your model slots (settings → models)`,
	);
}
