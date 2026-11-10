import { checkChatSettings } from "@/src/settings";
import { readJson } from "@/src/platform";
import { parseModelChoice } from "@/src/settings/model";
import { effectiveSettings } from "@/src/stores";
import { chatStore, requireChat } from "@/src/session";
import type { RequestEvent } from "./$types";

/**
 * The per-chat model control (model-control wave): replace-whole settings —
 * the picker sends the complete desired object ({} clears all overrides).
 * PER-SESSION MODELS (owner, 2026-09-28): this route is THE in-session
 * writer — the composer's control binds the session's own record; the
 * strong slot is only the birth default and never reaches an existing
 * session again.
 * Validation is the catalog gate (src/server/model-catalog.ts): unknown
 * provider/model is a 400. Thinking levels never reject (owner,
 * interlude 2026-09-22): a pinned level clamps to the named model's
 * nearest supported and the clamped value is stored. Effective next turn
 * by construction (agents are stateless per turn).
 */
export async function PUT({ request: req, params }: RequestEvent) {
	const { id } = params;
	const chat = await requireChat(id);
	if (chat instanceof Response) return chat;
	const json = await readJson(req);
	if (json instanceof Response) return json;
	const parsed = parseModelChoice(json.body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	const checked = checkChatSettings(parsed.value, effectiveSettings().models.strong);
	if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
	// Replace-whole: no merges, so a stale client can never resurrect a
	// cleared override.
	const settings = checked.value;
	await chatStore.saveSettings(id, settings);
	return Response.json({ settings });
}
