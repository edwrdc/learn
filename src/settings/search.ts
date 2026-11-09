/** Which search engine is live: the settings pin plus the engines' keys
 *  (env or auth file; env wins), read fresh each call so a key saved
 *  mid-session takes effect on the next check. */
import { braveProvider, resolveSearchEngineFor, tavilyProvider } from "../tools/index.ts";
import { SEARCH_ENGINES, type SearchEngineId, type SearchProvider, type SearchStatus } from "../tools/model/index.ts";
import { effectiveSettings } from "../stores.ts";
import { keyValue } from "./keys.ts";

/** The engine's key (env-or-file; env wins) — null when the engine is
 *  not keyed, which by owner decision means NOT LIVE. */
function engineKey(id: SearchEngineId): string | null {
	const envVar = SEARCH_ENGINES.find((e) => e.id === id)?.envVar;
	const value = envVar ? keyValue(envVar) : undefined;
	return value ? value : null;
}

function engineKeys(): Partial<Record<SearchEngineId, string>> {
	return Object.fromEntries(SEARCH_ENGINES.map((e) => [e.id, engineKey(e.id) ?? undefined]));
}

/** The live search state (the honest availability signal): reads the
 *  settings record's pin + the auth store fresh each call, so a key saved
 *  mid-session activates on the next check (no restart). */
export function searchStatus(): SearchStatus {
	const { available, engine, reason } = resolveSearchEngineFor(
		effectiveSettings().agent.search?.engine,
		engineKeys(),
	);
	return { available, engine, reason };
}

/** Search available at all? (the settings UI's gray-out signal + the
 *  researcher's enable/disable pin — Teacher stream's rewiring reads this.) */
export function searchAvailable(): boolean {
	return searchStatus().available;
}

/** The LIVE adapter, or null when unavailable. Composed fresh each call —
 *  the tool layer (Teacher stream) calls this once per search, so key
 *  rotations take effect immediately. */
export function searchProvider(): SearchProvider | null {
	const resolved = resolveSearchEngineFor(effectiveSettings().agent.search?.engine, engineKeys());
	if (!resolved.available || !resolved.key) return null;
	return resolved.engine === "tavily" ? tavilyProvider(resolved.key) : braveProvider(resolved.key);
}
