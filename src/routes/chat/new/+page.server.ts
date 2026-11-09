import { slotsConfigured } from "@/src/settings/model";
import { readSettings } from "@/src/settings";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ url }) => ({
	initialConfigured: slotsConfigured(readSettings()?.models),
	mode: url.searchParams.get("mode") === "practice" ? ("practice" as const) : ("teach" as const),
});
