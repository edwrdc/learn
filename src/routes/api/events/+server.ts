/**
 * The notification channel: one SSE connection per open window over the
 * server event bus.
 */
import { eventsResponse } from "@/src/platform";

export function GET(): Response {
	return eventsResponse();
}
