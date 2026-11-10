/**
 * Server-side persistence for THE user settings record (settings-storage
 * wave, 2026-09-19): data/settings.json (config.SETTINGS_FILE), under the
 * LH_DATA_DIR seam — read-modify-write, NOT a ledger. Non-secret product
 * preferences only; secrets stay in auth.json / .env.local.
 *
 * Everything off disk is sanitized (model/schema.ts) before it reaches a
 * caller; everything written was already validated by the routes and is
 * sanitized here again — the file can never hold a value that would
 * silently shift a knob.
 */

import { readJsonFile, writeJsonAtomic } from "../platform/index.ts";
import { SETTINGS_FILE } from "../platform/index.ts";
import { sanitizeUserSettings, type SettingsSection } from "./model/schema.ts";
import { CURRENT_SETTINGS_VERSION, type UserSettings } from "./model/settings.ts";

/** The persisted record, or null when none exists (first boot). */
export function readSettings(): UserSettings | null {
	const parsed = readJsonFile(SETTINGS_FILE);
	if (parsed === undefined) return null; // absent or corrupt: first-boot factory defaults
	return sanitizeUserSettings(parsed) ?? null;
}

/** Persist the record (sanitized). Returns what was written. */
export function writeSettings(raw: unknown): UserSettings {
	const settings = sanitizeUserSettings(raw);
	if (!settings) throw new Error("settings record must be a JSON object");
	writeJsonAtomic(SETTINGS_FILE, settings);
	return settings;
}

/** Read the record (or a fresh one), change it, write it back. */
export function updateSettings(change: (record: UserSettings) => unknown): UserSettings {
	return writeSettings(change(readSettings() ?? { version: CURRENT_SETTINGS_VERSION }));
}

/** Replace one section; the other sections ride along untouched. */
export function writeSettingsSection(section: SettingsSection, value: unknown): UserSettings {
	return updateSettings((record) => ({ ...record, [section]: value }));
}
