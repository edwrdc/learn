/**
 * The search-provider port. The settings record may name a preferred engine
 * (agent.search.engine); keys live in the auth store.
 *
 * Owner decisions:
 *  - No default engine: an engine is live iff its key is present, and a
 *    key alone activates it; agent.search.engine is only a preference.
 *  - Nothing silently falls back: no engine live = search is unavailable.
 */

/** One search result row — the shape every adapter must produce. */
export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

/** The search engines, in preference order (both keyed, no pin → the first
 *  wins; owner decision). */
export const SEARCH_ENGINES = [
	{ id: "tavily", envVar: "TAVILY_API_KEY", label: "Tavily" },
	{ id: "brave", envVar: "BRAVE_API_KEY", label: "Brave" },
] as const;

export type SearchEngineId = (typeof SEARCH_ENGINES)[number]["id"];

/** A live search engine. `search` throws on failure with a clear message;
 *  the tool layer catches and reports. */
export interface SearchProvider {
	id: SearchEngineId;
	search(query: string, count: number): Promise<SearchHit[]>;
}

/** Why search is (un)available — the status the UI and the tool layer
 *  explain from. */
export interface SearchStatus {
	available: boolean;
	/** The active engine (null when unavailable). */
	engine: SearchEngineId | null;
	/** The one-line reason for the state (status text for the UI). */
	reason: string;
}
