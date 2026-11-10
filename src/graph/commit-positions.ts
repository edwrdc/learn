/**
 * Server-side commit for the live physics drag (PUT /api/graph/positions).
 * The client's renderer anneals a drag to rest and PUTs the new rest
 * state; the server trusts it for the nodes it knows about and, if the
 * graph grew while the user was dragging (a merge landed), runs ONE
 * incremental settle (settleGraphLayout) so the fresh nodes are absorbed
 * into the frame the user just arranged — client positions act as
 * anchors, never as a clobber.
 *
 * Every body is sanitized: garbage coordinates clamp or drop, unknown
 * ids are discarded, nothing throws.
 *
 * KNOWN IDS = THE CANVAS'S WORLD: the derived view's nodes — stored
 * propositions AND the derived arg_ implication nodes. The canvas persists
 * all of them; stripping the args here would purge their ledger entries on
 * every drag-commit, so each mount would re-seed them on a giant ring.
 * arg_ ids are stable (minted from the chain ledger), so persisting them
 * is sound.
 */
import type { Position } from "./model/types.ts";
import { deriveView, getGraph } from "./snapshot.ts";
import { settleGraphLayout } from "./layout-settle.ts";
import { stores } from "../stores.ts";

/** Max |x| or |y| accepted — NaN/Infinity clamp here, absurd too. */
const MAX_COORD = 1e6;

/**
 * Accepts the raw PUT body (a Record of id → {x, y}) and returns the
 * sanitized positions actually persisted (empty object = nothing written,
 * e.g. a body with no known ids — the caller reports but never fails).
 */
export function commitPositions(input: unknown): Record<string, Position> {
	if (typeof input !== "object" || input === null) return {};
	const raw = input as Record<string, unknown>;

	// The same derivation the snapshot serves, so ids agree by construction.
	const known = new Set(deriveView(getGraph(stores.graphStore)).nodes.map((n) => n.id));

	const positions: Record<string, Position> = {};
	for (const [id, value] of Object.entries(raw)) {
		if (!known.has(id)) continue;
		if (typeof value !== "object" || value === null) continue;
		const { x, y } = value as Record<string, unknown>;
		if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y))
			continue;
		positions[id] = {
			x: Math.min(Math.max(x, -MAX_COORD), MAX_COORD),
			y: Math.min(Math.max(y, -MAX_COORD), MAX_COORD),
		};
	}
	if (Object.keys(positions).length === 0) return {};

	// The graph grew past what the client knew (a merge landed mid-drag):
	// settle the new nodes with the client's rest state as anchors.
	if ([...known].some((id) => !(id in positions))) settleGraphLayout(stores.graphStore, positions);
	else stores.graphStore.writePositions(positions);
	return positions;
}