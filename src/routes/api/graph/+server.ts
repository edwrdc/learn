import { graphView } from "@/src/graph";

/**
 * The home graph view's data: nodes, edges, session provenance, and
 * per-session understanding observations.
 */

export async function GET() {
	return Response.json(await graphView());
}
