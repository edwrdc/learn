/**
 * GET/PUT/DELETE /api/custom-endpoint — the ONE optional custom OpenAI
 * Responses endpoint (custom-endpoint wave).
 *
 * GET    → {endpoint, keyPresent} (the API key itself NEVER leaves the
 *          server; only its presence is reported).
 * PUT    → {displayName, baseUrl, models, apiKey?} — strict validation;
 *          Omit apiKey to reuse the active key for an unchanged base URL.
 * DELETE → removes the config + stored key only. Chats/graph are untouched;
 *          saved model pins keep failing with the setup refusal instead of
 *          silently falling back.
 */

import {
	customEndpointState,
	removeCustomEndpoint,
	saveCustomEndpoint,
} from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(customEndpointState());
}

export async function PUT(request: Request) {
	const body = await request.json().catch(() => null);
	const result = saveCustomEndpoint(body);
	if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
	return Response.json(result.state);
}

export async function DELETE() {
	return Response.json(removeCustomEndpoint());
}
