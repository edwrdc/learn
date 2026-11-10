/**
 * GET /api/settings — THE user settings record: the whole delta record at
 * data/settings.json. Non-secret by construction — secrets live in
 * auth.json / .env.local and never enter this record.
 *
 *   GET → 200 {settings} (the sanitized delta record — absent keys mean
 *         "factory default", never guessed server-side) or 200
 *         {settings: null} on first boot.
 *
 * Section writes go through PUT /api/settings/[section]. Resolution to
 * concrete values is the client's job (resolveSettings is browser-safe).
 */

import { readSettings } from "@/src/settings";

export async function GET() {
	return Response.json({ settings: readSettings() });
}
