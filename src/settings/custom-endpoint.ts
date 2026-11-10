
import { processState } from "../platform/model/index.ts";
import { createHash } from "node:crypto";
import {
	CUSTOM_ENDPOINT_DISCOVERY_TIMEOUT_MS,
	CUSTOM_ENDPOINT_KEY_ID,
	CUSTOM_ENDPOINT_KEY_PREFIX,
	CUSTOM_ENDPOINT_PROVIDER_ID,
	customEndpointModelsUrl,
	isCustomEndpointKeyId,
	normalizeCustomEndpointBaseUrl,
	parseCustomModelsDiscovery,
	validateCustomEndpointConfig,
	type CustomEndpointConfig,
	type CustomEndpointKeySource,
	type CustomEndpointState,
	type DiscoveredCustomModel,
} from "./model/custom-endpoint.ts";
import { genericProviderKeyGuard } from "./model/auth-keys.ts";
import { setCustomEndpointProvider, piEngineForSpec, piModels, runsSnapshot, type ModelSnapshot, type PiEngine, type ResolvedModelSpec } from "../platform/index.ts";
import { modelKey, providerKeyMissing, type ModelSlotName, type ProviderKeyMissing } from "./model/index.ts";
import { readSettings, updateSettings } from "./store.ts";
import { authStore } from "./auth-store.ts";
import {
	deleteSecretVar,
	secretFromRealEnv,
	keyValue,
	providerKeyPresent,
	saveSecretVar,
} from "./keys.ts";

function originKeyId(baseUrl: string): string {
	const digest = createHash("sha256").update(baseUrl).digest("hex").slice(0, 24);
	return `${CUSTOM_ENDPOINT_KEY_PREFIX}_${digest}`;
}

interface ActiveKey {
	id: string;
	key: string;
	source: Exclude<CustomEndpointKeySource, "none">;
}

function activeKeyFor(endpoint: CustomEndpointConfig): ActiveKey | undefined {
	if (secretFromRealEnv(CUSTOM_ENDPOINT_KEY_ID)) {
		const key = keyValue(CUSTOM_ENDPOINT_KEY_ID);
		if (key) return { id: CUSTOM_ENDPOINT_KEY_ID, key, source: "env" };
	}
	const id = originKeyId(endpoint.baseUrl);
	const key = keyValue(id);
	if (key) return { id, key, source: secretFromRealEnv(id) ? "env" : "file" };
	return undefined;
}

function synced(): { signature?: string } {
	return processState("customEndpointSync", () => ({}));
}

function signature(endpoint: CustomEndpointConfig | null, key: string | undefined): string {
	return JSON.stringify([endpoint, key ?? null]);
}

/**
 * Make pi-ai's provider collection match the persisted config AND the key
 * bound to its origin. Called at the top of every server surface that
 * reads/validates/builds an engine, so a save/edit/remove lands on the next
 * request with no restart and no stale provider surviving. Returns the
 * endpoint it synced from.
 */
function syncCustomEndpointProvider(): CustomEndpointConfig | null {
	const endpoint = readSettings()?.customEndpoint ?? null;
	const key = endpoint ? activeKeyFor(endpoint)?.key : undefined;
	const next = signature(endpoint, key);
	const registered = piModels().getProvider(CUSTOM_ENDPOINT_PROVIDER_ID) !== undefined;
	if (next !== synced().signature || (endpoint ? !registered : registered)) {
		setCustomEndpointProvider(endpoint, key);
		synced().signature = next;
	}
	return endpoint;
}

/** The safe GET view: configuration + key presence/provenance, never the key. */
export function customEndpointState(): CustomEndpointState {
	const endpoint = syncCustomEndpointProvider();
	const active = endpoint ? activeKeyFor(endpoint) : undefined;
	return {
		endpoint,
		keyPresent: active !== undefined,
		keySource: active?.source ?? "none",
	};
}

/** The refusal for work about to run on `provider` when its key is gone,
 *  else null. A pinned model is not enough: without the key the run dies
 *  mid-stream with a generic provider error. */
export function missingProviderKey(provider: string, slots: ModelSlotName[]): ProviderKeyMissing | null {
	const present =
		provider === CUSTOM_ENDPOINT_PROVIDER_ID ? customEndpointState().keyPresent : providerKeyPresent(provider);
	return present ? null : providerKeyMissing(provider, slots);
}

/** The optional pasted key in a save or discovery body: "" when absent,
 *  else a trimmed key that passed the shape check. */
function submittedKeyOf(raw: unknown): { ok: true; key: string } | { ok: false; error: string } {
	const apiKey = (raw as { apiKey?: unknown }).apiKey;
	if (apiKey !== undefined && typeof apiKey !== "string") return { ok: false, error: "apiKey must be a string" };
	const key = apiKey?.trim() ?? "";
	if (key) {
		const shape = genericProviderKeyGuard(CUSTOM_ENDPOINT_KEY_ID, key);
		if (!shape.ok) return shape;
	}
	return { ok: true, key };
}

type CustomEndpointWriteResult =
	| { ok: true; state: CustomEndpointState }
	| { ok: false; error: string };

const ENV_OWNED_ERROR =
	"LH_CUSTOM_ENDPOINT_API_KEY is set in the environment and owns this key — unset it to use a pasted key";
const ENV_REBIND_ERROR =
	"LH_CUSTOM_ENDPOINT_API_KEY is set in the environment — unset it before changing the base URL";

function pruneEndpointKeys(keepId?: string): void {
	for (const id of Object.keys(authStore.authVars())) {
		if (!isCustomEndpointKeyId(id) || id === keepId) continue;
		deleteSecretVar(id);
	}
}

/**
 * Save/replace the one endpoint with origin-safe ordering: a NEW URL writes
 * its key under that origin's id before committing settings, so a failure
 * leaves the old config+key pair intact; a SAME-URL key rotation commits
 * settings first, so a settings failure leaves the working key un-clobbered.
 * The env-owned fixed key is never written or shadowed: a pasted key is
 * refused, and a URL change is refused until the env var is unset.
 */
export function saveCustomEndpoint(raw: unknown): CustomEndpointWriteResult {
	const config = validateCustomEndpointConfig(raw);
	if (!config.ok) return config;
	const submitted = submittedKeyOf(raw);
	if (!submitted.ok) return submitted;
	const submittedKey = submitted.key;

	const stored = readSettings()?.customEndpoint ?? null;
	const envOwned = secretFromRealEnv(CUSTOM_ENDPOINT_KEY_ID);
	const baseChanged = !stored || stored.baseUrl !== config.value.baseUrl;

	if (envOwned) {
		if (submittedKey) return { ok: false, error: ENV_OWNED_ERROR };
		if (stored && baseChanged) return { ok: false, error: ENV_REBIND_ERROR };
		if (!keyValue(CUSTOM_ENDPOINT_KEY_ID)) return { ok: false, error: "API key is required" };
	} else if (!submittedKey) {
		const current = stored ? activeKeyFor(stored) : undefined;
		if (baseChanged) {
			return {
				ok: false,
				error: stored
					? "Enter the API key again when changing the base URL"
					: "API key is required",
			};
		}
		if (!current) return { ok: false, error: "API key is required" };
	}

	const targetKeyId = originKeyId(config.value.baseUrl);
	if (submittedKey && baseChanged) saveSecretVar(targetKeyId, submittedKey);
	updateSettings((record) => ({ ...record, customEndpoint: config.value }));
	if (submittedKey && !baseChanged) saveSecretVar(targetKeyId, submittedKey);
	if (!envOwned) {
		pruneEndpointKeys(targetKeyId);
	}
	return { ok: true, state: customEndpointState() };
}

/**
 * Remove the endpoint: config first, then every stored custom-endpoint key.
 * Chats and graph data are untouched; saved model pins remain in their
 * records and surface the existing setup refusal instead of a silent
 * fallback. A settings failure leaves the prior config+key working.
 */
export function removeCustomEndpoint(): CustomEndpointState {
	updateSettings(({ customEndpoint: _removed, ...rest }) => rest);
	pruneEndpointKeys();
	return customEndpointState();
}

type DiscoveryResult =
	| { ok: true; models: DiscoveredCustomModel[] }
	| { ok: false; error: string; status: 400 | 502 };

function discoveryFailure(error: unknown): DiscoveryResult {
	const errorName = error instanceof Error ? error.name : "";
	const causeName = error instanceof Error && error.cause instanceof Error ? error.cause.name : "";
	if (["TimeoutError", "AbortError"].includes(errorName) || ["TimeoutError", "AbortError"].includes(causeName)) {
		return { ok: false, status: 502, error: "Model discovery timed out" };
	}
	const message =
		error instanceof Error
			? `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`
			: "";
	if (/redirect/i.test(message)) {
		return { ok: false, status: 502, error: "The endpoint redirected; redirects are not followed" };
	}
	return { ok: false, status: 502, error: "Could not reach the endpoint" };
}

/**
 * The explicit "Fetch models" call. Uses the typed key when provided;
 * otherwise the key bound to the STORED URL. An env-owned fixed key is used
 * only after the endpoint has been saved (so it is explicitly bound to that
 * URL) and never for a URL change. Redirects are refused so a credential is
 * never replayed to another origin.
 */
export async function discoverCustomEndpointModels(raw: unknown): Promise<DiscoveryResult> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, status: 400, error: "body must be {baseUrl, apiKey?}" };
	}
	const submitted = submittedKeyOf(raw);
	if (!submitted.ok) return { ok: false, status: 400, error: submitted.error };
	const baseUrl = normalizeCustomEndpointBaseUrl((raw as { baseUrl?: unknown }).baseUrl);
	if (!baseUrl.ok) return { ok: false, status: 400, error: baseUrl.error };
	const submittedKey = submitted.key;
	const stored = readSettings()?.customEndpoint ?? null;
	const envOwned = secretFromRealEnv(CUSTOM_ENDPOINT_KEY_ID);

	let key: string | undefined;
	if (envOwned) {
		if (submittedKey) return { ok: false, status: 400, error: ENV_OWNED_ERROR };
		if (!stored) {
			return {
				ok: false,
				status: 400,
				error: "Save the endpoint first — an environment-owned key is only used for the stored base URL",
			};
		}
		if (stored.baseUrl !== baseUrl.value) return { ok: false, status: 400, error: ENV_REBIND_ERROR };
		key = keyValue(CUSTOM_ENDPOINT_KEY_ID);
	} else {
		key = submittedKey || (stored && stored.baseUrl === baseUrl.value ? activeKeyFor(stored)?.key : undefined);
	}
	if (!key) {
		return {
			ok: false,
			status: 400,
			error: stored && stored.baseUrl !== baseUrl.value
				? "API key is required to fetch models from a new base URL"
				: "API key is required",
		};
	}

	try {
		const res = await fetch(customEndpointModelsUrl(baseUrl.value), {
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
			redirect: "error",
			signal: AbortSignal.timeout(CUSTOM_ENDPOINT_DISCOVERY_TIMEOUT_MS),
		});
		if (!res.ok) {
			const hint = res.status === 401 || res.status === 403 ? " — check the API key" : "";
			return { ok: false, status: 502, error: `Model discovery failed (HTTP ${res.status})${hint}` };
		}
		let payload: unknown;
		try {
			payload = await res.json();
		} catch {
			return { ok: false, status: 502, error: "Endpoint did not return JSON" };
		}
		const models = parseCustomModelsDiscovery(payload);
		if (!models.ok) return { ok: false, status: 502, error: models.error };
		return { ok: true, models: models.value };
	} catch (error) {
		return discoveryFailure(error);
	}
}

/** pi's Models collection with the stored custom endpoint registered: every
 *  catalog read goes through here, so a saved edit lands on the next read. */
export function catalogModels() {
	syncCustomEndpointProvider();
	return piModels();
}

/** Build an engine against the stored custom endpoint (see catalogModels). */
export function engineForSpec(spec: ResolvedModelSpec): PiEngine {
	syncCustomEndpointProvider();
	return piEngineForSpec(spec);
}

/** Rebuild a recovered run's engine from its snapshot, or undefined when
 *  that model can no longer run it. */
export function engineForSnapshot(snapshot: ModelSnapshot): PiEngine | undefined {
	try {
		const engine = engineForSpec({
			provider: snapshot.provider,
			id: snapshot.modelId,
			thinkingLevel: snapshot.thinking as ResolvedModelSpec["thinkingLevel"],
		});
		return runsSnapshot(engine, snapshot) ? engine : undefined;
	} catch (error) {
		console.info(`[models] cannot restore ${modelKey(snapshot.provider, snapshot.modelId)}:`, error);
		return undefined;
	}
}
