import type { GraphNode } from "./types.ts";
import { stripModelValueDebris } from "../../platform/model/index.ts";

/** Selection-facing chain views. */

/** One reasoning chain as a selection sees it: a stored chain (premises →
 *  conclusion), or a singleton (premises: []) for a node in no surviving
 *  chain. */
export interface ReasoningChain {
	/** The stored chain's id (arg_…), or the node's id for a singleton. */
	id: string;
	/** Premise node ids, sorted. Empty = a singleton chain. */
	premises: string[];
	conclusion: string;
}

/** The stored chains filtered to a selection: a chain rides along iff its conclusion AND every premise
 *  are selected; a node in no surviving chain is a singleton chain
 *  (premises: []). Premise-only nodes whose chain was excluded are
 *  singletons. Every stored chain keeps its OWN id (arg_…) — two independent
 *  arguments for one conclusion stay distinct. Deterministic: chains
 *  sorted by id, premises sorted. */
export function chainsForSelection(
	nodes: ReadonlyArray<Pick<{ id: string }, "id">>,
	chains: ReadonlyArray<Pick<{ id: string; premises: string[]; conclusion: string }, "id" | "premises" | "conclusion">>,
): ReasoningChain[] {
	const selected = new Set(nodes.map((n) => n.id));
	const chained = new Set<string>();
	const included: ReasoningChain[] = [];
	for (const chain of chains) {
		if (!selected.has(chain.conclusion)) continue;
		if (!chain.premises.every((premise) => selected.has(premise))) continue;
		included.push({ id: chain.id, premises: [...chain.premises].sort(), conclusion: chain.conclusion });
		chained.add(chain.conclusion);
		for (const premise of chain.premises) chained.add(premise);
	}
	for (const node of nodes) {
		if (!chained.has(node.id)) {
			included.push({ id: node.id, premises: [], conclusion: node.id });
		}
	}
	return included.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Resolve ONE target string to a canonical proposition id: id first (exact), then
 *  name (case-insensitive, trimmed — names are presentational handles,
 *  not unique; an ambiguous name resolves to the FIRST node in store
 *  order). Returns null when nothing matches — the caller rejects.
 *  Validation set is the WHOLE graph, not the session's picks: pickless
 *  sessions stay valid. The debris strip heals copy-syntax (`:node-id`, quoted ids)
 *  before matching — targets are membership values like correctAnswer. */
export function resolveTargetId(
	target: string,
	nodes: ReadonlyArray<Pick<GraphNode, "id" | "name">>,
): string | null {
	const t = stripModelValueDebris(target);
	if (t.length === 0) return null;
	if (nodes.some((n) => n.id === t)) return t;
	const lower = t.toLowerCase();
	for (const n of nodes) {
		if (stripModelValueDebris(n.name).toLowerCase() === lower) return n.id;
	}
	return null;
}

/** A chain as one world-facing line — the propositions' NAMES joined
 *  by the derivation arrow: "Premise one, Premise two → Conclusion"; a
 *  singleton shows its "(no premises)" marker. Unknown ids fall back to
 *  the raw id. Premises sort by id, like chainsForSelection. */
export function formatChainLine(
	chain: Pick<ReasoningChain, "premises" | "conclusion">,
	propositions: Readonly<Record<string, { name: string }>>,
): string {
	const nameOf = (id: string) => propositions[id]?.name ?? id;
	const premises = [...chain.premises].sort().map(nameOf).join(", ");
	return premises !== ""
		? `${premises} → ${nameOf(chain.conclusion)}`
		: `${nameOf(chain.conclusion)} (no premises)`;
}
