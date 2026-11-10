/**
 * The server event bus (owner decision: notify → fetch, no standing polls).
 * GET /api/events turns every emission into an SSE frame for any open
 * window. Events carry the fact, never the data: consumers fetch truth on
 * receipt, so payloads stay tiny and idempotent — a reconnect heals by
 * refetching.
 */

import { processState } from "./process.ts";

/** The full event vocabulary. */
export interface ServerEvents {
	/** A turn began server-side, whatever its origin (send, wake, other tab). */
	"turn-started": { chatId: string };
	/** A turn settled — emitted only after the record is current, so any
	 *  fetch triggered by this event reads it. */
	"turn-settled": { chatId: string };
	/** A job record changed (dispatch, progress, settle, abort, recovery).
	 *  chatId when known — consumers that own one chat filter on it. */
	"jobs-changed": { chatId?: string };
	/** An extraction run changed phase (activity dock). */
	"activity-changed": Record<string, never>;
	/** The session list changed (create, delete, title). */
	"chats-changed": Record<string, never>;
	/** A chat's record changed without a turn (the silent dismissal write). */
	"record-changed": { chatId: string };
	/** A compaction started/finished for the chat. running=true is the send
	 *  gate: the server refuses model interaction for the chat and the client
	 *  mirrors it by disabling submit. */
	"compaction-changed": { chatId: string; running: boolean };
}

export type ServerEventType = keyof ServerEvents;

/** The vocabulary's runtime names — the client wires one listener per name. */
export const SERVER_EVENT_TYPES = [
	"turn-started",
	"turn-settled",
	"jobs-changed",
	"activity-changed",
	"chats-changed",
	"record-changed",
	"compaction-changed",
] as const satisfies readonly ServerEventType[];

export type ServerEvent<K extends ServerEventType = ServerEventType> = {
	type: K;
} & ServerEvents[K];

type ServerEventListener = (event: ServerEvent) => void;

/** Ephemeral: emitters never queue for absent listeners. */
function listeners(): Set<ServerEventListener> {
	return processState("eventBus", () => new Set<ServerEventListener>());
}

/** Returns the unsubscribe function. */
export function subscribe(listener: ServerEventListener): () => void {
	const set = listeners();
	set.add(listener);
	return () => set.delete(listener);
}

/** Notify every listener. One listener throwing never breaks the others
 *  or the emitter. */
export function emit<K extends ServerEventType>(type: K, payload: ServerEvents[K]): void {
	for (const listener of [...listeners()]) {
		try {
			listener({ type, ...payload } as ServerEvent);
		} catch (err) {
			console.error(`[events] listener failed on ${type}:`, err);
		}
	}
}
