import { slotsConfigured } from "@/src/core";
import { readSettingsRecord } from "@/src/server";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ url }) => ({
	initialConfigured: slotsConfigured(readSettingsRecord()?.models),
	mode: url.searchParams.get("mode") === "practice" ? ("practice" as const) : ("teach" as const),
});
