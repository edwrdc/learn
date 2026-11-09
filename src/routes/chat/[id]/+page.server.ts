import { error } from "@sveltejs/kit";
import { slotsConfigured } from "@/src/settings/model";
import { compactionInFlight, getChat, isTurnRunning } from "@/src/session";
import { readSettings } from "@/src/settings";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, url }) => {
	const chat = await getChat(params.id);
	if (!chat) error(404, "Not Found");
	const record = readSettings();
	return {
		chatId: chat.id,
		title: chat.title,
		kind: chat.kind ?? "teach",
		initialMessages: chat.messages,
		initialConfigured: slotsConfigured(record?.models),
		initialPrompt: url.searchParams.get("prompt") ?? undefined,
		initiallyInFlight: await isTurnRunning(chat.id),
		initiallyCompacting: compactionInFlight(chat.id),
	};
};
