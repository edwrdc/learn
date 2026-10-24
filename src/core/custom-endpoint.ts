/**
 * ONE user-configured OpenAI Responses endpoint (custom-endpoint wave).
 * Pure, browser-safe: the settings UI renders the form from these shapes,
 * the server validates writes with the same functions, and the agent's
 * model factory projects the stored models into pi-ai's catalog.
 *
 * THE BOUNDARY: custom endpoints speak openai-responses ONLY. There is no
 * protocol selector, no per-model price entry, and no ambient defaults —
 * every model's limits/capabilities are explicit user input, because none
 * of it can be discovered from /models (the endpoint lists ids, not
 * context windows or modalities). Prices stay UNKNOWN by construction
 * (ModelCost is numeric inside pi-ai, but the app never displays those
 * placeholder zeros — core/prices.ts has no entry for the provider, so the
 * money channel reads unpriced).
 */

/** The fixed provider id every custom model carries. Stored pins survive
 *  display-name edits because this id never changes. */
export const CUSTOM_ENDPOINT_PROVIDER_ID = "custom-endpoint";

/** The fixed environment override and prefix for URL-bound auth-store keys.
 * Pasted keys use a hash of the normalized base URL as a suffix and never
 * appear in settings.json. */
export const CUSTOM_ENDPOINT_KEY_PREFIX = "LH_CUSTOM_ENDPOINT_API_KEY";
export const CUSTOM_ENDPOINT_KEY_ID = CUSTOM_ENDPOINT_KEY_PREFIX;

/** Is this an auth-store id owned by the custom endpoint (the fixed env
 *  override, the legacy file key, or a per-origin stored key)? */
export function isCustomEndpointKeyId(id: string): boolean {
	return id === CUSTOM_ENDPOINT_KEY_ID || id.startsWith(`${CUSTOM_ENDPOINT_KEY_PREFIX}_`);
}

export const CUSTOM_ENDPOINT_DISCOVERY_TIMEOUT_MS = 10_000;

export interface CustomEndpointModel {
	/** The id sent to the endpoint (and the model id shown in pickers). */
	id: string;
	/** Display name from discovery, or the id for manual entries. */
	name: string;
	/** Explicit context window; no invented default exists. */
	contextWindow: number;
	/** Explicit max output tokens; no invented default exists. */
	maxTokens: number;
	/** Whether the model accepts thinking levels. */
	reasoning: boolean;
	/** Whether the model accepts image input. */
	imageInput: boolean;
}

/** The one stored endpoint configuration (nonsecret — the API key lives in
 *  auth.json, never here). */
export interface CustomEndpointConfig {
	displayName: string;
	/** Normalized base URL, no trailing slash (e.g. https://host/v1). */
	baseUrl: string;
	models: CustomEndpointModel[];
}

/** A discovered model row — the /models listing carries ids (and sometimes
 *  names); limits/capabilities still require explicit user input. */
export interface DiscoveredCustomModel {
	id: string;
	name: string;
}

export type CustomEndpointResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function text(value: unknown, field: string, max: number): CustomEndpointResult<string> {
	if (typeof value !== "string") return { ok: false, error: `${field} must be a string` };
	const trimmed = value.trim();
	if (!trimmed) return { ok: false, error: `${field} is required` };
	if (trimmed.length > max) return { ok: false, error: `${field} must be at most ${max} characters` };
	if (CONTROL_CHARS.test(trimmed)) return { ok: false, error: `${field} must not contain control characters` };
	return { ok: true, value: trimmed };
}

/** Is this host literally loopback? HTTP is allowed ONLY here; HTTPS is
 *  allowed anywhere. Plain names/IPs only — a DNS name that happens to
 *  resolve to 127.0.0.1 still requires HTTPS (we do not resolve names). */
export function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return (
		host === "localhost" ||
		host === "::1" ||
		host === "[::1]" ||
		/^127(\.\d{1,3}){3}$/.test(host)
	);
}

/**
 * Validate + normalize a user-supplied base URL:
 *  - http(s) only; HTTP only for loopback hosts;
 *  - no embedded credentials, query, or fragment (the endpoint appends
 *    /models and uses the URL as an API base, so those would be lies);
 *  - trailing slashes stripped, other path segments preserved.
 */
export function normalizeCustomEndpointBaseUrl(raw: unknown): CustomEndpointResult<string> {
	const parsedText = text(raw, "Base URL", 2048);
	if (!parsedText.ok) return parsedText;
	let url: URL;
	try {
		url = new URL(parsedText.value);
	} catch {
		return { ok: false, error: "Base URL must be a valid URL" };
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return { ok: false, error: "Base URL must start with https:// (or http:// for a loopback host)" };
	}
	if (url.username || url.password) {
		return { ok: false, error: "Base URL must not contain credentials — the API key is stored separately" };
	}
	if (url.search || url.hash) {
		return { ok: false, error: "Base URL must not contain a query or fragment" };
	}
	if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
		return { ok: false, error: "Plain HTTP is only allowed for localhost/127.0.0.1/::1 — use HTTPS for remote endpoints" };
	}
	if (!url.hostname) return { ok: false, error: "Base URL must include a host" };
	const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
	return { ok: true, value: `${url.origin}${path}` };
}

/** The absolute /models URL for a normalized base URL (discovery seam). */
export function customEndpointModelsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/models`;
}

function positiveInteger(value: unknown, field: string, max: number): CustomEndpointResult<number> {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		return { ok: false, error: `${field} must be a positive integer` };
	}
	if (value > max) return { ok: false, error: `${field} must be at most ${max}` };
	return { ok: true, value };
}

function parseModel(raw: unknown, index: number): CustomEndpointResult<CustomEndpointModel> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, error: `models[${index}] must be an object` };
	}
	const r = raw as Record<string, unknown>;
	const id = text(r.id, `models[${index}].id`, 512);
	if (!id.ok) return id;
	const name = r.name === undefined ? { ok: true as const, value: id.value } : text(r.name, `models[${index}].name`, 512);
	if (!name.ok) return name;
	const contextWindow = positiveInteger(r.contextWindow, `models[${index}].contextWindow`, 100_000_000);
	if (!contextWindow.ok) return contextWindow;
	const maxTokens = positiveInteger(r.maxTokens, `models[${index}].maxTokens`, 100_000_000);
	if (!maxTokens.ok) return maxTokens;
	if (maxTokens.value > contextWindow.value) {
		return { ok: false, error: `models[${index}].maxTokens must not exceed its contextWindow` };
	}
	if (typeof r.reasoning !== "boolean") return { ok: false, error: `models[${index}].reasoning must be a boolean` };
	if (typeof r.imageInput !== "boolean") return { ok: false, error: `models[${index}].imageInput must be a boolean` };
	return {
		ok: true,
		value: {
			id: id.value,
			name: name.value,
			contextWindow: contextWindow.value,
			maxTokens: maxTokens.value,
			reasoning: r.reasoning,
			imageInput: r.imageInput,
		},
	};
}

/** Validate endpoint configuration and reject duplicate model IDs.
 * Missing model names default to their IDs. Errors are returned to the caller. */
export function validateCustomEndpointConfig(raw: unknown): CustomEndpointResult<CustomEndpointConfig> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, error: "Endpoint configuration must be an object" };
	}
	const r = raw as Record<string, unknown>;
	const displayName = text(r.displayName, "Display name", 80);
	if (!displayName.ok) return displayName;
	const baseUrl = normalizeCustomEndpointBaseUrl(r.baseUrl);
	if (!baseUrl.ok) return baseUrl;
	if (!Array.isArray(r.models)) return { ok: false, error: "models must be an array" };
	const models: CustomEndpointModel[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of r.models.entries()) {
		const parsed = parseModel(entry, index);
		if (!parsed.ok) return parsed;
		if (seen.has(parsed.value.id)) {
			return { ok: false, error: `models[${index}].id duplicates "${parsed.value.id}"` };
		}
		seen.add(parsed.value.id);
		models.push(parsed.value);
	}
	return { ok: true, value: { displayName: displayName.value, baseUrl: baseUrl.value, models } };
}

/** LENIENT disk-side sanitizer: the display name/base URL gate the whole
 *  entry; an individually invalid model is dropped (the strict write side
 *  is where those become 400s). Never throws. */
export function sanitizeCustomEndpoint(raw: unknown): CustomEndpointConfig | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	const displayName = text(r.displayName, "Display name", 80);
	if (!displayName.ok) return undefined;
	const baseUrl = normalizeCustomEndpointBaseUrl(r.baseUrl);
	if (!baseUrl.ok) return undefined;
	if (!Array.isArray(r.models)) return undefined;
	const models: CustomEndpointModel[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of r.models.entries()) {
		const parsed = parseModel(entry, index);
		if (!parsed.ok || seen.has(parsed.value.id)) continue;
		seen.add(parsed.value.id);
		models.push(parsed.value);
	}
	return { displayName: displayName.value, baseUrl: baseUrl.value, models };
}

/**
 * Parse a /models response into deduped {id,name} rows. The OpenAI
 * convention ({data:[...]}) is the contract; a bare array is accepted
 * because several compatible servers return one. Anything else is an
 * honest failure — never a guessed model list.
 */
export function parseCustomModelsDiscovery(raw: unknown): CustomEndpointResult<DiscoveredCustomModel[]> {
	const list = Array.isArray(raw)
		? raw
		: raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)
			? ((raw as { data: unknown[] }).data)
			: null;
	if (!list) return { ok: false, error: "Endpoint did not return a model list" };
	const models: DiscoveredCustomModel[] = [];
	const seen = new Set<string>();
	for (const entry of list) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const r = entry as Record<string, unknown>;
		if (typeof r.id !== "string") continue;
		const id = r.id.trim();
		if (!id || CONTROL_CHARS.test(id) || id.length > 512 || seen.has(id)) continue;
		const rawName = typeof r.name === "string" ? r.name.trim() : "";
		const name = rawName && rawName.length <= 512 && !CONTROL_CHARS.test(rawName) ? rawName : id;
		seen.add(id);
		models.push({ id, name });
	}
	return { ok: true, value: models };
}
