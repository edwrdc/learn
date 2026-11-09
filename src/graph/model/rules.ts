/** The graph's identity rules, each defined once. Pure. */

import type { GraphChain } from "./types.ts";

/** Chains (arguments) are ids "arg_…": a chain's id is also its derived
 *  implication node's id, collision-free with propositions' "n_…". */
export const ARG_ID_PREFIX = "arg_";

export function isArgumentId(id: string): boolean {
	return id.startsWith(ARG_ID_PREFIX);
}

/** A chain's merge key: sorted premises + conclusion — an assertion that
 *  re-states the same argument merges under it. */
export function chainKey(premises: ReadonlyArray<string>, conclusion: string): string {
	return `${[...premises].sort().join("+")}>${conclusion}`;
}

/** A chain draws only while its conclusion and every premise are live. */
export function chainIsLive(chain: Pick<GraphChain, "premises" | "conclusion">, live: ReadonlySet<string>): boolean {
	return live.has(chain.conclusion) && chain.premises.every((premise) => live.has(premise));
}

/** Ledger lines → one per id: the FIRST line for an id defines it. */
export function firstLineById<T extends { id: string }>(lines: readonly T[]): T[] {
	const seen = new Set<string>();
	return lines.filter((line) => !seen.has(line.id) && seen.add(line.id));
}

/** Drop the positions of removed ids. */
export function prunePositions<P>(positions: Record<string, P>, removed: ReadonlySet<string>): Record<string, P> {
	return Object.fromEntries(Object.entries(positions).filter(([id]) => !removed.has(id)));
}
