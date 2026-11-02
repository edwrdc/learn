import { handleChatRequest } from "@/src/server";
import type { RequestEvent } from "./$types";

export async function POST({ request: req }: RequestEvent) {
	return handleChatRequest(req);
}
