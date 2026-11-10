import path from "node:path";
import { fileURLToPath } from "node:url";

// Bundled config lives in server/chunks; the launcher supplies the prompt-asset root.
export const ROOT = process.env.LH_ROOT
	? path.resolve(process.env.LH_ROOT)
	: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * LH_DATA_DIR relocates every mutable record when set. The desktop shell
 * points it at userData so nothing is written inside the read-only .app
 * bundle (macOS translocation makes the bundle read-only anyway). Unset, it
 * resolves to the repo's data/. Read-only assets (prompts) stay ROOT-anchored:
 * they ship inside the app bundle.
 */
const DATA_ROOT = process.env.LH_DATA_DIR
	? path.resolve(process.env.LH_DATA_DIR)
	: path.join(ROOT, "data");

export const PATHS = {
	root: ROOT,
	/** The agents' prompt tree (shipped as a runtime asset). */
	prompts: path.join(ROOT, "src", "session", "prompts"),
	data: DATA_ROOT,
	/** Chat session metadata (one JSON file per chat; the transcript lives
	 *  in the durable store). */
	chats: path.join(DATA_ROOT, "chats"),
	graph: path.join(DATA_ROOT, "graph"),
	/** Debug artifacts (env-gated): data/debug/provider-events/<chatId>.jsonl
	 * raw provider stream recordings (src/platform/provider-events.ts). */
	debug: path.join(DATA_ROOT, "debug"),
} as const;

/**
 * The user settings record: one versioned, delta-shaped JSON blob holding
 * every non-secret product preference. Explicit user choices only: absent
 * keys resolve to FACTORY_SETTINGS (src/settings/model/settings.ts), so an
 * update that adds a knob needs no migration. The version field is a private
 * schema counter for breaking shape changes only, unrelated to the app
 * release version. Secrets never live here — auth.json / .env.local keep
 * that role.
 */
export const SETTINGS_FILE = path.join(DATA_ROOT, "settings.json");

/**
 * User prompt-override files, mirroring the source layout
 * (src/session/prompts/). File presence alone is not the override:
 * settings.json's agent.prompts map (segmentPath → boolean) is the explicit
 * switch, so a user can keep a customized file on disk but run the source
 * default to compare. The segment list is always derived from source at
 * runtime (src/session/prompts.ts); an override keyed to a vanished segment
 * stops composing but stays on disk.
 */
export const PROMPTS_OVERRIDE_DIR = path.join(DATA_ROOT, "prompts");

/**
 * The BYOK key store: a flat {VAR: value} JSON map. Desktop main.cjs passes
 * LH_AUTH_FILE pointing at userData/auth.json (mode 0600); in dev the default
 * is the repo-root auth.json (gitignored; a worktree may symlink it). The
 * server re-reads it on every access, so hand-edits and key changes need no
 * restart. Values reach process.env at boot with fill-gap precedence — real
 * environment variables (incl. .env.local in dev) always win
 * (src/settings/keys.ts).
 */
export const AUTH_FILE = process.env.LH_AUTH_FILE
	? path.resolve(process.env.LH_AUTH_FILE)
	: path.join(ROOT, "auth.json");
