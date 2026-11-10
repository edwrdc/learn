/**
 * The flat {VAR: value} auth.json map at AUTH_FILE: mode 0600, atomic
 * writes, re-read from disk on every access so hand-edits keep working.
 *
 * keys.ts is the only intended writer: it applies shape validation and env
 * precedence. This adapter persists what it is given, never throws
 * (absent/corrupt file reads as "no keys yet"), and preserves unknown vars
 * verbatim.
 */

import { readJsonFile, writeFileAtomic } from "../platform/index.ts";
import { AUTH_FILE } from "../platform/index.ts";
import type { AuthStore } from "./model/ports.ts";

function readMap(): Record<string, string> {
	const raw = readJsonFile(AUTH_FILE);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "string") as [string, string][]);
}

function writeMap(map: Record<string, string>): void {
	writeFileAtomic(AUTH_FILE, `${JSON.stringify(map, null, "\t")}\n`, { mode: 0o600 });
}

export const authStore: AuthStore = {
	authVars() {
		return readMap();
	},
	setAuthVar(name, value) {
		const map = readMap();
		map[name] = value;
		writeMap(map);
	},
	deleteAuthVar(name) {
		const map = readMap();
		if (!(name in map)) return;
		delete map[name];
		writeMap(map);
	},
};
