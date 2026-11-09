/**
 * PUT/DELETE /api/settings/prompts/[...segment] — the override TEXT for one
 * prompt segment. PUT {text} writes it (a current source segment only);
 * DELETE removes the file and clears its switch in the same operation.
 * The ON/OFF switch itself is written through PUT /api/settings/agent.
 */

import { deletePromptOverride, writePromptOverride } from "@/src/session";
import { isValidSegmentPath } from "@/src/settings/model";
import { readJson } from "@/src/platform";
import type { RequestEvent } from "./$types";

const INVALID_PATH = () => Response.json({ error: "invalid segment path" }, { status: 400 });

export async function PUT({ request, params }: RequestEvent) {
	const path = params.segment;
	if (!isValidSegmentPath(path)) return INVALID_PATH();
	const json = await readJson(request);
	if (json instanceof Response) return json;
	const text = (json.body as { text?: unknown } | null)?.text;
	if (typeof text !== "string") return Response.json({ error: "body must be {text: string}" }, { status: 400 });
	const written = writePromptOverride(path, text);
	if (!written.ok) return Response.json({ error: written.error, supported: written.supported }, { status: 400 });
	return Response.json({ path, text });
}

export async function DELETE({ params }: RequestEvent) {
	const path = params.segment;
	if (!isValidSegmentPath(path)) return INVALID_PATH();
	return Response.json({ path, deleted: true, ...deletePromptOverride(path) });
}
