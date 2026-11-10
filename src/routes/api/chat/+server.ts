import { handleChatRequest } from "@/src/session";
import type { RequestEvent } from "./$types";

export async function POST({ request: req }: RequestEvent) {
	return handleChatRequest(req);
}
