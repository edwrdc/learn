/**
 * PUT /api/settings/[section] — replaces ONE section of settings.json
 * (absent fields = absent overrides); other sections and unknown keys ride
 * along untouched. The body is parsed strictly by the settings schema; a
 * section may add a catalog check and a transform below.
 *
 * Thinking levels never reject a write (owner, interlude 2026-09-22): a
 * pinned level CLAMPS to the named model's nearest supported level.
 *
 * Prompt switches heal instead of rejecting (interlude 2026-09-26): an ON
 * switch whose override file is gone (or whose segment left the source
 * tree) drops to OFF inside the same write, so a user can never get stuck
 * unable to write settings.
 */

import { isSettingsSection, parseSection, SETTINGS_SECTIONS, type AgentSettings, type ModelsSettings, type SettingsSection } from "@/src/settings/model";
import { checkModelsSettings, writeSettingsSection } from "@/src/settings";
import { healPromptSwitches } from "@/src/session";
import { readJson } from "@/src/platform";
import type { RequestEvent } from "./$types";

type Checked = { ok: true; value: unknown } | { ok: false; error: string; supported?: string[] };

/** Per-section checks and transforms after the shape parse. */
const SECTION_WRITES: { [S in SettingsSection]?: (value: never) => Checked } = {
	models: (value: ModelsSettings) => checkModelsSettings(value),
	agent: (value: AgentSettings) => ({ ok: true, value: healPromptSwitches(value) }),
};

export async function PUT({ request, params }: RequestEvent) {
	const { section } = params;
	if (!isSettingsSection(section)) {
		return Response.json({ error: `unknown settings section "${section}"`, supported: Object.keys(SETTINGS_SECTIONS) }, { status: 404 });
	}
	const json = await readJson(request);
	if (json instanceof Response) return json;
	const parsed = parseSection(section, json.body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	const write = SECTION_WRITES[section] as ((value: unknown) => Checked) | undefined;
	const checked = write ? write(parsed.value) : { ok: true as const, value: parsed.value };
	if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
	return Response.json({ settings: writeSettingsSection(section, checked.value) });
}
