/**
 * Persistence for the user settings record (SETTINGS_FILE) —
 * read-modify-write, not a ledger. Everything read or written is sanitized
 * (model/schema.ts), so the file never holds a value that would silently
 * shift a knob.
 */

import { readJsonFile, writeJsonAtomic } from "../platform/index.ts";
import { SETTINGS_FILE } from "../platform/index.ts";
import { sanitizeUserSettings, type SettingsSection } from "./model/schema.ts";
import { CURRENT_SETTINGS_VERSION, type UserSettings } from "./model/settings.ts";

/** The persisted record, or null when none exists (first boot). */
export function readSettings(): UserSettings | null {
	const parsed = readJsonFile(SETTINGS_FILE);
	if (parsed === undefined) return null;
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

export function writeSettingsSection(section: SettingsSection, value: unknown): UserSettings {
	return updateSettings((record) => ({ ...record, [section]: value }));
}
