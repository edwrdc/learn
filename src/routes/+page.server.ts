import { resolveSettings, slotsConfigured } from "@/src/settings/model";
import { readSettings } from "@/src/settings";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = () => {
	const record = readSettings();
	return {
		initialConfigured: slotsConfigured(record?.models),
		rendering: resolveSettings(record ?? null).graph.rendering,
	};
};
