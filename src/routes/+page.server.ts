import { resolveSettings, slotsConfigured } from "@/src/core";
import { readSettingsRecord } from "@/src/server";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = () => {
	const record = readSettingsRecord();
	return {
		initialConfigured: slotsConfigured(record?.models),
		rendering: resolveSettings(record ?? null).graph.rendering,
	};
};
