/**
 * POST /api/custom-endpoint/models — the explicit "Fetch models" action
 * (custom-endpoint wave). Reads {baseUrl, apiKey?} from the form, calls the
 * endpoint's /models with the provided key or — only for the STORED base
 * URL — the stored key, and returns normalized {id,name} rows. Redirects
 * are refused so a credential is never replayed to another origin.
 */

import { discoverCustomEndpointModels } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body = await request.json().catch(() => null);
	const result = await discoverCustomEndpointModels(body);
	if (!result.ok) {
		return Response.json({ error: result.error }, { status: result.status });
	}
	return Response.json({ models: result.models });
}
