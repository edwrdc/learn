/**
 * The settings record's fields, defined once. Each field rule gives both
 * directions:
 *
 *  - read: whatever comes from disk — invalid values drop (resolve to the
 *    factory default) and numbers clamp; it never throws, so an older or
 *    hand-edited record never bricks the app;
 *  - write: a PUT body — a bad type or shape is a 400 naming the field.
 *
 * Sections are replace-whole on write; unknown keys in a body drop. Unknown
 * TOP-LEVEL keys on disk are preserved verbatim (a newer record must survive
 * an older app).
 */

import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
import { SEARCH_ENGINES, WRITABLE_TOOL_KEYS } from "../../tools/model/index.ts";
import { sanitizeRenderSettings, type GraphRenderSettings } from "./graph-render.ts";
import { sanitizeCustomEndpoint } from "./custom-endpoint.ts";
import {
	BACKGROUND_MODEL_ROLES,
	COMPACTION_THRESHOLD_FLOOR,
	CURRENT_SETTINGS_VERSION,
	EXTRACTION_CHUNK_TOKENS_FLOOR,
	MODEL_SLOTS,
	THINKING_LEVELS,
	type AgentSettings,
	type AppearanceSettings,
	type CompactionSettings,
	type GraphSettings,
	type ModelChoice,
	type ModelsSettings,
	type UserSettings,
} from "./settings.ts";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

interface Field<T> {
	read(raw: unknown): T | undefined;
	write(raw: unknown, path: string): Parsed<T>;
}

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (error: string): Parsed<never> => ({ ok: false, error });
const at = (path: string, key: string) => (path ? `${path}.${key}` : key);

function asRecord(raw: unknown): Record<string, unknown> | null {
	return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

const bool: Field<boolean> = {
	read: (raw) => (typeof raw === "boolean" ? raw : undefined),
	write: (raw, path) => (typeof raw === "boolean" ? ok(raw) : fail(`${path} must be a boolean`)),
};

function oneOf<const V extends string>(values: readonly V[]): Field<V> {
	const has = (raw: unknown): raw is V => typeof raw === "string" && (values as readonly string[]).includes(raw);
	return {
		read: (raw) => (has(raw) ? raw : undefined),
		write: (raw, path) => (has(raw) ? ok(raw) : fail(`${path} must be ${values.map((v) => `"${v}"`).join(" or ")}`)),
	};
}

export function isHexColor(value: string): boolean {
	return /^#[0-9a-fA-F]{3}$/.test(value) || /^#[0-9a-fA-F]{6}$/.test(value);
}

/** A #hex color, or null for the default. */
const hexOrNull: Field<string | null> = {
	read: (raw) => (typeof raw === "string" && isHexColor(raw) ? raw : null),
	write: (raw, path) =>
		raw === null || (typeof raw === "string" && isHexColor(raw)) ? ok(raw) : fail(`${path} must be a #hex color or null`),
};

/** A non-empty name, or null for the default. */
const nameOrNull: Field<string | null> = {
	read: (raw) => (typeof raw === "string" && raw.trim() ? raw : null),
	write: (raw, path) =>
		raw === null || (typeof raw === "string" && raw.trim()) ? ok(raw) : fail(`${path} must be a non-empty string or null`),
};

/** An integer in [min, max]; a disk value rounds and clamps. */
function intRange(min: number, max: number): Field<number> {
	return {
		read: (raw) => (typeof raw === "number" && Number.isFinite(raw) ? Math.min(Math.max(Math.round(raw), min), max) : undefined),
		write: (raw, path) =>
			typeof raw === "number" && Number.isInteger(raw) && raw >= min && raw <= max
				? ok(raw)
				: fail(`${path} must be an integer between ${min} and ${max}`),
	};
}

/** A token budget with a floor and no ceiling; a disk value below the floor
 *  clamps up, a written one is refused with `why`. */
function tokens(floor: number, why: string): Field<number> {
	return {
		read: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.max(floor, Math.floor(raw)) : undefined),
		write: (raw, path) => {
			if (typeof raw !== "number" || !Number.isFinite(raw)) return fail(`${path} must be a number`);
			const floored = Math.floor(raw);
			return floored < floor ? fail(`${path} must be at least ${floor} (${why})`) : ok(floored);
		},
	};
}

/** A map of booleans; on write its keys must be in `keys` when given. */
function boolMap(keys?: { allowed: readonly string[]; noun: string }): Field<Record<string, boolean>> {
	return {
		read: (raw) => {
			const record = asRecord(raw);
			if (!record) return undefined;
			const out = Object.fromEntries(Object.entries(record).filter(([, v]) => typeof v === "boolean")) as Record<string, boolean>;
			return Object.keys(out).length ? out : undefined;
		},
		write: (raw, path) => {
			const record = asRecord(raw);
			if (!record) return fail(`${path} must be an object`);
			for (const [key, value] of Object.entries(record)) {
				if (typeof value !== "boolean") return fail(`${path}.${key} must be a boolean`);
				if (keys && !keys.allowed.includes(key)) {
					return fail(`unknown ${keys.noun} "${key}" (supported: ${keys.allowed.join(", ")})`);
				}
			}
			return ok(record as Record<string, boolean>);
		},
	};
}

type Fields<T> = { [K in keyof T]-?: Field<Exclude<T[K], undefined>> };

/** An object of known fields. `path` "" is a whole PUT body. */
function section<T extends object>(fields: Fields<T>): Field<T> {
	const entries = Object.entries(fields) as Array<[string, Field<unknown>]>;
	return {
		read: (raw) => {
			const record = asRecord(raw);
			if (!record) return undefined;
			const out: Record<string, unknown> = {};
			for (const [key, field] of entries) {
				if (record[key] === undefined) continue;
				const value = field.read(record[key]);
				if (value !== undefined) out[key] = value;
			}
			return out as T;
		},
		write: (raw, path) => {
			const record = asRecord(raw);
			if (!record) return fail(path ? `${path} must be an object` : "Invalid JSON body");
			const out: Record<string, unknown> = {};
			for (const [key, field] of entries) {
				if (record[key] === undefined) continue;
				const parsed = field.write(record[key], at(path, key));
				if (!parsed.ok) return parsed;
				out[key] = parsed.value;
			}
			return ok(out as T);
		},
	};
}

/** A model pick: `{ model?: {provider, id}, thinkingLevel? }` — the shape of
 *  a chat's settings, a slot and a background role override. */
const modelChoice: Field<ModelChoice> = {
	read: (raw) => {
		const record = asRecord(raw);
		if (!record) return undefined;
		const out: ModelChoice = {};
		const model = asRecord(record.model);
		if (model && typeof model.provider === "string" && typeof model.id === "string") {
			out.model = { provider: model.provider, id: model.id };
		}
		const level = oneOf(THINKING_LEVELS).read(record.thinkingLevel);
		if (level) out.thinkingLevel = level;
		return Object.keys(out).length ? out : undefined;
	},
	write: (raw, path) => {
		const record = asRecord(raw);
		if (!record) return fail(path ? `${path} must be an object` : "Invalid JSON body");
		const out: ModelChoice = {};
		if (record.model !== undefined) {
			const model = asRecord(record.model);
			if (!model || typeof model.provider !== "string" || typeof model.id !== "string") {
				return fail(`${at(path, "model")} must be {provider, id}`);
			}
			out.model = { provider: model.provider, id: model.id };
		}
		if (record.thinkingLevel !== undefined) {
			const level = oneOf<ThinkingLevel>(THINKING_LEVELS).write(record.thinkingLevel, at(path, "thinkingLevel"));
			if (!level.ok) return level;
			out.thinkingLevel = level.value;
		}
		return ok(out);
	},
};

/** A record keyed by a fixed set (roles, slots) of model choices. On write a
 *  key outside the set is refused, and a slot must name a model. */
function choicesBy<K extends string>(keys: readonly K[], noun: string, requireModel: boolean): Field<Partial<Record<K, ModelChoice>>> {
	return {
		read: (raw) => {
			const record = asRecord(raw);
			if (!record) return undefined;
			const out: Partial<Record<K, ModelChoice>> = {};
			for (const key of keys) {
				const choice = modelChoice.read(record[key]);
				if (choice) out[key] = choice;
			}
			return Object.keys(out).length ? out : undefined;
		},
		write: (raw, path) => {
			const record = asRecord(raw);
			if (!record) return fail(path ? `${path} must be an object` : "Invalid JSON body");
			const out: Partial<Record<K, ModelChoice>> = {};
			for (const [key, value] of Object.entries(record)) {
				if (!(keys as readonly string[]).includes(key)) {
					return fail(`unknown ${noun} "${key}" (supported: ${keys.join(", ")})`);
				}
				const choice = modelChoice.write(value, key);
				if (!choice.ok) return choice;
				if (requireModel && !choice.value.model) {
					return fail(`${noun} "${key}" must set a model (thinkingLevel alone cannot run — absent ${noun} = unset)`);
				}
				if (Object.keys(choice.value).length) out[key as K] = choice.value;
			}
			return ok(out);
		},
	};
}

/** The graph view's sliders: a disk value or a body snaps and clamps into
 *  range, never a 400 (the sliders only produce valid values). */
const graphRender: Field<GraphRenderSettings> = {
	read: (raw) => (asRecord(raw) ? sanitizeRenderSettings(raw) : undefined),
	write: (raw) => (asRecord(raw) ? ok(sanitizeRenderSettings(raw)) : fail("Invalid JSON body")),
};

/** The sections PUT /api/settings/[section] writes. */
export const SETTINGS_SECTIONS = {
	agent: section<AgentSettings>({
		models: choicesBy(BACKGROUND_MODEL_ROLES, "role", false),
		tools: boolMap({ allowed: WRITABLE_TOOL_KEYS, noun: "tool" }),
		prompts: boolMap(),
		search: section({ engine: oneOf(SEARCH_ENGINES.map((engine) => engine.id)) }),
		graphTools: section({ enabled: bool }),
	}),
	models: choicesBy(MODEL_SLOTS, "slot", true) as Field<ModelsSettings>,
	appearance: section<AppearanceSettings>({
		mode: oneOf(["dark", "light"]),
		background: hexOrNull,
		fontFamily: nameOrNull,
		proseFontSize: intRange(12, 24),
		sessionNameSerif: bool,
		mdRendering: section({ headingWeight: intRange(100, 900), boldColor: hexOrNull, italicColor: hexOrNull }),
	}),
	graph: section<GraphSettings>({
		enabled: bool,
		rendering: bool,
		extractionChunkTokens: tokens(EXTRACTION_CHUNK_TOKENS_FLOOR, "smaller batches waste the per-run graph overhead"),
	}),
	compaction: section<CompactionSettings>({
		thresholdTokens: tokens(COMPACTION_THRESHOLD_FLOOR, "compaction keeps a ~20k-token recent tail — smaller budgets would churn it"),
	}),
	graphRender,
};

export type SettingsSection = keyof typeof SETTINGS_SECTIONS;

export function isSettingsSection(name: string): name is SettingsSection {
	return Object.hasOwn(SETTINGS_SECTIONS, name);
}

/** Parse one PUT body for a section (strict). */
export function parseSection<S extends SettingsSection>(name: S, body: unknown): Parsed<UserSettings[S] & object> {
	return SETTINGS_SECTIONS[name].write(body, "") as Parsed<UserSettings[S] & object>;
}

/** Parse a chat's own model settings (PUT /api/chats/[id]/settings). */
export function parseModelChoice(body: unknown): Parsed<ModelChoice> {
	return modelChoice.write(body, "");
}

/** Sections this app no longer has; a record that still holds one drops it. */
const RETIRED_SECTIONS = ["chat", "general"];

/** Coerce arbitrary JSON from disk into a valid record. Never throws;
 *  non-objects → null. */
export function sanitizeUserSettings(raw: unknown): UserSettings | null {
	const record = asRecord(raw);
	if (!record) return null;
	const version = record.version;
	const out: UserSettings = {
		version: typeof version === "number" && Number.isInteger(version) && version >= 1 ? version : CURRENT_SETTINGS_VERSION,
	};
	for (const [name, field] of Object.entries(SETTINGS_SECTIONS) as Array<[string, Field<object>]>) {
		const value = field.read(record[name]);
		if (value !== undefined) out[name] = value;
	}
	const customEndpoint = record.customEndpoint === undefined ? undefined : sanitizeCustomEndpoint(record.customEndpoint);
	if (customEndpoint) out.customEndpoint = customEndpoint;
	for (const [key, value] of Object.entries(record)) {
		if (key === "version" || key === "customEndpoint" || isSettingsSection(key) || RETIRED_SECTIONS.includes(key)) continue;
		out[key] = value;
	}
	return out;
}
