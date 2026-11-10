/** Which search engine is live: the settings pin plus the engines' keys,
 *  read fresh each call so a key saved mid-session takes effect at once. */
import { braveProvider, resolveSearchEngineFor, tavilyProvider } from "../tools/index.ts";
import { SEARCH_ENGINES, type SearchEngineId, type SearchProvider, type SearchStatus } from "../tools/model/index.ts";
import { effectiveSettings } from "../stores.ts";
import { keyValue } from "./keys.ts";

/** Null when the engine is not keyed, which by owner decision means not live. */
function engineKey(id: SearchEngineId): string | null {
	const envVar = SEARCH_ENGINES.find((e) => e.id === id)?.envVar;
	const value = envVar ? keyValue(envVar) : undefined;
	return value ? value : null;
}

function engineKeys(): Partial<Record<SearchEngineId, string>> {
	return Object.fromEntries(SEARCH_ENGINES.map((e) => [e.id, engineKey(e.id) ?? undefined]));
}

export function searchStatus(): SearchStatus {
	const { available, engine, reason } = resolveSearchEngineFor(
		effectiveSettings().agent.search?.engine,
		engineKeys(),
	);
	return { available, engine, reason };
}

/** The live adapter, or null when unavailable. */
export function searchProvider(): SearchProvider | null {
	const resolved = resolveSearchEngineFor(effectiveSettings().agent.search?.engine, engineKeys());
	if (!resolved.available || !resolved.key) return null;
	return resolved.engine === "tavily" ? tavilyProvider(resolved.key) : braveProvider(resolved.key);
}
