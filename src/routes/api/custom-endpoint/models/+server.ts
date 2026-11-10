/**
 * POST /api/custom-endpoint/models — the explicit "Fetch models" action.
 * Reads {baseUrl, apiKey?} from the form, calls the endpoint's /models with
 * the provided key or — only for the STORED base URL — the stored key, and
 * returns normalized {id,name} rows. Redirects are refused so a credential
 * is never replayed to another origin.
 */

import { discoverCustomEndpointModels } from "@/src/settings";
import { readJson } from "@/src/platform";
import type { RequestEvent } from "./$types";

export async function POST({ request }: RequestEvent) {
	const json = await readJson(request);
	if (json instanceof Response) return json;
	const body = json.body;
	const result = await discoverCustomEndpointModels(body);
	if (!result.ok) {
		return Response.json({ error: result.error }, { status: result.status });
	}
	return Response.json({ models: result.models });
}
