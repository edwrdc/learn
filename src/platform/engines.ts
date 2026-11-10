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
import { processState } from "./model/index.ts";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
import { DEFAULT_THINKING_ORDER } from "../settings/model/index.ts";
import {
	CUSTOM_ENDPOINT_PROVIDER_ID,
	type CustomEndpointConfig,
} from "../settings/model/index.ts";
import packageMetadata from "../../package.json" with { type: "json" };
import type { ProviderEventObserver } from "./provider-events.ts";

/** App identity is immutable and shared by Models and the durable Harness.
 * The Harness's default attribution is pi's, so the app identity overrides it. */
export const APP_IDENTITY = Object.freeze({
	userAgent: Object.freeze({ custom: `learnharness/${packageMetadata.version}` }),
	attribution: Object.freeze({ name: packageMetadata.name, url: packageMetadata.homepage }),
});

/**
 * The one engine factory every agent's model comes from. BYOK all the way
 * down (owner decision): there are no factory model pins — every engine
 * resolves from a resolved spec (the settings chain's output).
 *
 * An "engine" is the model + the stream function the durable Harness runs on
 * — the two things a test fake replaces.
 */

export interface PiEngine {
	model: Model<Api>;
	streamFn: StreamFunction;
	/** The resolved, clamped thinking level (observability + tests; the
	 *  streamFn pins it anyway). */
	level?: ThinkingLevel;
}

/** The secret-free model selection a run was admitted under; recovery
 *  rebuilds the run's engine from it, never from later settings. */
export interface ModelSnapshot {
	provider: string;
	modelId: string;
	thinking?: string;
	baseUrl?: string;
}

export function modelSnapshot(engine: PiEngine): ModelSnapshot {
	return {
		provider: engine.model.provider,
		modelId: engine.model.id,
		...(engine.level ? { thinking: engine.level } : {}),
		...(engine.model.baseUrl ? { baseUrl: engine.model.baseUrl } : {}),
	};
}

/** Does the engine run the snapshot's model? A custom endpoint edited to
 *  another base URL must not take over a run admitted against the old one. */
export function runsSnapshot(engine: PiEngine, snapshot: ModelSnapshot): boolean {
	if (engine.model.provider !== snapshot.provider || engine.model.id !== snapshot.modelId) return false;
	if (snapshot.provider !== CUSTOM_ENDPOINT_PROVIDER_ID || !snapshot.baseUrl) return true;
	return engine.model.baseUrl === snapshot.baseUrl;
}

/** The process-wide pi-ai Models collection with every builtin provider's
 *  catalog. Auth is resolved per request by pi-ai from the environment (file-
 *  saved keys are reflected into env), and a provider with no key fails its
 *  stream with "not configured" — unreachable through the picker, which
 *  gates on keyPresent. */
export function piModels() {
	return processState("piModels", () => {
		const collection = createModels({ identity: APP_IDENTITY });
		for (const provider of builtinProviders()) collection.setProvider(provider);
		return collection;
	});
}

/** Per-conversation engine bindings for the durable Harness. The Harness's
 *  `models` reader is process-wide and every conversation shares one Harness,
 *  so a single "current engine" would let one turn's settings redirect
 *  another conversation's request. The router keys by the provider session
 *  id the Harness forwards as `sessionId` on every request. */
interface RunBinding {
	engine: PiEngine;
	observer?: ProviderEventObserver;
}

function modelsGlobal(): { routed?: Models } {
	return processState("routedModels", () => ({}));
}

function runBindings(): Map<string, RunBinding> {
	return processState("runBindings", () => new Map());
}

/** Bind one conversation's provider session id to its captured engine. The
 *  engine's stream function still owns the provider/credential/thinking pin. */
export function bindRunEngine(sessionId: string, engine: PiEngine, observer?: ProviderEventObserver): void {
	runBindings().set(sessionId, { engine, observer });
}

export function unbindRunEngine(sessionId: string): void {
	runBindings().delete(sessionId);
}

/** The Models collection the durable Harness reads: the process catalog with
 *  per-session engine dispatch. `getModel` prefers a bound engine's captured
 *  model object (endpoint limits and base URL snapshots stay pinned); the
 *  request itself always streams through the bound engine, so which model
 *  object getModel happened to return cannot redirect a provider request.
 *
 *  The raw-wire recorder rides `options.onProviderStreamEvent` (pi-ai's
 *  pre-normalization observer). It is forwarded into the engine's streamFn
 *  options — never reconstructed from the normalized event stream. */
export function routedModels(): Models {
	const existing = modelsGlobal().routed;
	if (existing) return existing;
	const bindings = runBindings();
	const base = piModels();
	const stream = (
		model: Model<Api>,
		context: Parameters<StreamFunction>[1],
		options?: Parameters<StreamFunction>[2],
	) => {
		const binding = options?.sessionId ? bindings.get(options.sessionId) : undefined;
		if (!binding) return base.streamSimple(model, context, options);
		const observer = binding.observer;
		const upstream = options?.onProviderStreamEvent;
		const forwarded =
			observer === undefined
				? options
				: {
						...options,
						onProviderStreamEvent: async (data: unknown, observed: Model<Api>) => {
							if (upstream) await upstream(data, observed);
							observer(data, observed);
						},
					};
		return binding.engine.streamFn(binding.engine.model, context, forwarded);
	};
	const routed = new Proxy(base, {
		get(target, property) {
			if (property === "getModel") {
				return (provider: string, id: string) => {
					for (const { engine } of bindings.values()) {
						if (engine.model.provider === provider && engine.model.id === id) return engine.model;
					}
					return target.getModel(provider, id);
				};
			}
			if (property === "streamSimple") return stream;
			if (property === "completeSimple") {
				return (model: Model<Api>, context: Parameters<StreamFunction>[1], options?: Parameters<StreamFunction>[2]) =>
					stream(model, context, options).result();
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	modelsGlobal().routed = routed;
	return routed;
}

interface CustomProviderSnapshot {
	config: CustomEndpointConfig;
	provider: Provider;
	apiKey: string | undefined;
}

function customSnapshot(): { current?: CustomProviderSnapshot } {
	return processState("customProvider", () => ({}));
}

/**
 * Register (or remove) the user-configured OpenAI Responses provider in the
 * process-wide collection.
 *
 * The model entries' pi-ai costs are placeholders: the app's money channel
 * reads src/session/model/prices.ts, where this provider is absent, so its
 * prices stay unpriced (never a fabricated zero).
 *
 * `apiKey` is the key already resolved for this exact base URL. Capturing it
 * here (not an env lookup at request time) keeps an engine's endpoint +
 * credential immutable across later edits/removals. */
export function setCustomEndpointProvider(config: CustomEndpointConfig | null, apiKey?: string): void {
	const models = piModels();
	if (!config) {
		customSnapshot().current = undefined;
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
	customSnapshot().current = { config, provider, apiKey };
	models.setProvider(provider);
}

/** Follow no redirects on a custom endpoint: the Authorization header must
 *  never be replayed to a different origin. Composes the caller's fetch (the
 *  test seam) when present. */
function noRedirectFetch(upstream: typeof fetch): typeof fetch {
	return (input, init) => upstream(input, { ...init, redirect: "error" });
}

/** A fully-resolved model pin: the settings-resolution chain's output.
 *  Unset thinkingLevel means the first entry of DEFAULT_THINKING_ORDER the
 *  model supports. */
export interface ResolvedModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

/** A non-reasoning model reports exactly ["off"] from pi-ai. */
function defaultThinkingLevel(model: Model<Api>): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

/** The production engine for a resolved spec. Builtin engines resolve auth
 *  per request through the Models collection. A custom engine captures the
 *  published provider + credential at construction, so an edit/removal can
 *  never redirect an already-running turn (or swap its key mid-turn). */
export function piEngineForSpec(spec: ResolvedModelSpec): PiEngine {
	const custom = spec.provider === CUSTOM_ENDPOINT_PROVIDER_ID ? customSnapshot().current : undefined;
	const models: Models = piModels();
	const model =
		spec.provider === CUSTOM_ENDPOINT_PROVIDER_ID
			? custom?.provider.getModels().find((m) => m.id === spec.id)
			: models.getModel(spec.provider, spec.id);
	if (!model) throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
	// pi-ai's `reasoning` scale has no "off": undefined means off.
	const level = spec.thinkingLevel ? clampThinkingLevel(model, spec.thinkingLevel) : defaultThinkingLevel(model);
	const reasoning = level === "off" ? undefined : level;
	if (custom) {
		const { provider, apiKey } = custom;
		return {
			model,
			level,
			streamFn: (_requestModel, context, options) => {
				const upstream = options?.fetch ?? fetch;
				return provider.streamSimple(model, context, {
					...options,
					apiKey,
					identity: options?.identity ?? APP_IDENTITY,
					reasoning,
					fetch: noRedirectFetch(upstream),
				});
			},
		};
	}
	return {
		model,
		level,
		streamFn: (_requestModel, context, options) => models.streamSimple(model, context, { ...options, reasoning }),
	};
}

