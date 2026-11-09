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

import { CURRENT_SETTINGS_VERSION, isSettingsSection, parseSection, SETTINGS_SECTIONS, type AgentSettings, type ModelsSettings, type SettingsSection } from "@/src/settings/model";
import { clampModelsLevels, promptOverrides, readSettings, validateModelsSettings, writeSettings } from "@/src/settings";
import { allSegmentPaths } from "@/src/session";
import type { RequestEvent } from "./$types";

type Refusal = { error: string; supported?: string[] };

/** Per-section checks and transforms after the shape parse. */
const SECTION_WRITES: { [S in SettingsSection]?: (value: never) => { ok: true; value: unknown } | ({ ok: false } & Refusal) } = {
	models: (value: ModelsSettings) => {
		const verdict = validateModelsSettings(value);
		return verdict.ok ? { ok: true, value: clampModelsLevels(value) } : { ok: false, error: verdict.error, supported: verdict.supported };
	},
	agent: (value: AgentSettings) => {
		const segments = new Set(allSegmentPaths());
		const orphans = Object.entries(value.prompts ?? {})
			.filter(([path, on]) => on && (!segments.has(path) || promptOverrides.readOverride(path) === null))
			.map(([path]) => path);
		if (orphans.length === 0) return { ok: true, value };
		console.info(`[settings] healed orphaned prompt switch(es) to off: ${orphans.join(", ")}`);
		const prompts = Object.fromEntries(Object.entries(value.prompts ?? {}).filter(([path]) => !orphans.includes(path)));
		return { ok: true, value: { ...value, prompts } };
	},
};

export async function PUT({ request, params }: RequestEvent) {
	const { section } = params;
	if (!isSettingsSection(section)) {
		return Response.json({ error: `unknown settings section "${section}"`, supported: Object.keys(SETTINGS_SECTIONS) }, { status: 404 });
	}
	const parsed = parseSection(section, await request.json().catch(() => null));
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	const write = SECTION_WRITES[section] as ((value: unknown) => ReturnType<NonNullable<(typeof SECTION_WRITES)["models"]>>) | undefined;
	const checked = write ? write(parsed.value) : { ok: true as const, value: parsed.value };
	if (!checked.ok) return Response.json({ error: checked.error, supported: checked.supported }, { status: 400 });

	const next = { ...(readSettings() ?? { version: CURRENT_SETTINGS_VERSION }), [section]: checked.value };
	writeSettings(next);
	return Response.json({ settings: next });
}
