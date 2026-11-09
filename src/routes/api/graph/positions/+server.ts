/**
 * PUT /api/graph/positions — the live-physics drag commit. The client
 * anneals a drag to rest and sends the new positions; the server
 * sanitizes (finite coords, known ids only), writes the ledger, and if
 * the graph grew mid-drag runs one incremental settle to absorb the new
 * nodes with the client's arrangement as anchors. See
 * src/server/commit-positions.ts.
 *
 *   PUT → 200 {positions: {...}} with whatever survived sanitizing
 *         (empty object = nothing written).
 */
import { commitPositions } from "@/src/graph";
import { readJson } from "@/src/platform";
import type { RequestEvent } from "./$types";

export async function PUT({ request }: RequestEvent) {
	const json = await readJson(request);
	if (json instanceof Response) return json;
	return Response.json({ positions: commitPositions(json.body) });
}
