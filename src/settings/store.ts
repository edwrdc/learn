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

import fs from "node:fs";
import path from "node:path";
import { SETTINGS_FILE } from "../platform/index.ts";
import { sanitizeUserSettings } from "./model/schema.ts";
import type { UserSettings } from "./model/settings.ts";
import type { SettingsStore } from "./model/ports.ts";

/** The persisted record, or null when none exists (first boot). */
export function readSettings(): UserSettings | null {
	let raw: string;
	try {
		raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
	} catch {
		return null; // no settings.json yet — first boot, all factory defaults
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null; // corrupt → first-boot semantics (all factory defaults)
	}
	const record = sanitizeUserSettings(parsed);
	if (!record) return null;
	return record;
}

/** Persist the record (sanitized). Returns what was written. */
export function writeSettings(raw: unknown): UserSettings {
	const settings = sanitizeUserSettings(raw);
	if (!settings) throw new Error("settings record must be a JSON object");
	fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, "\t"), "utf-8");
	return settings;
}

/** The typed adapter (core/ports.ts SettingsStore), for the composition root. */
export const settingsStore: SettingsStore = {
	readSettings,
	writeSettings,
};
