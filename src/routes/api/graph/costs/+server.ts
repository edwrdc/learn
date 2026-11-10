/**
 * GET /api/graph/costs — the graph view's cost pill: what the graph PIPELINE
 * cost, folded read-time from the three usage channels (chat extraction
 * runs, notes-source runs, cluster-naming runs). Dollars are inferred from
 * PRICES at read time — never stored, so a price sync re-prices the whole
 * history for free.
 *
 * Scope (owner decision): the graph pipeline ONLY — teaching turns and
 * sub-agent jobs have their own cost channels elsewhere.
 */
import { graphCosts } from "@/src/graph";

export async function GET() {
	return Response.json(await graphCosts());
}
