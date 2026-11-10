/**
 * The notification channel: GET /api/events is an SSE response over the
 * server event bus — one connection per open window, held open until the
 * view goes away.
 *
 * Notify → fetch: frames carry only the event type + a tiny payload;
 * consumers respond by fetching truth. No payload versioning, no replay
 * protocol — a reconnect resyncs with one ordinary fetch per consumer. Push
 * over polling is an owner decision: a desktop app on loopback holds 1-3
 * idle connections for free.
 *
 * A `: ping` comment every 25s keeps any intermediary from idling the socket
 * out and makes dead-connection detection cheap. Unlike the turn stream
 * (which ends at [DONE]), this channel ends only when the client goes away.
 */
import { SSE_HEADERS } from "./http.ts";
import { subscribe, type ServerEvent } from "./model/events.ts";

/** One window's subscription as an SSE Response. */
export function eventsResponse(): Response {
	const encoder = new TextEncoder();
	let teardown: (() => void) | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let heartbeat: ReturnType<typeof setInterval> | undefined;
			let unsubscribe: (() => void) | undefined;

			const stop = () => {
				if (closed) return;
				closed = true;
				unsubscribe?.();
				if (heartbeat) clearInterval(heartbeat);
			};
			// Enqueue throws once the reader died.
			const frame = (chunk: string) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					stop();
				}
			};

			unsubscribe = subscribe((event: ServerEvent) => {
				const { type, ...payload } = event;
				frame(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
			});
			heartbeat = setInterval(() => frame(": ping\n\n"), 25_000);

			teardown = stop;
		},
		cancel() {
			teardown?.();
		},
	});
	return new Response(stream, {
		headers: SSE_HEADERS,
	});
}
