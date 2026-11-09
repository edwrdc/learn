/**
 * PARKED DISMISSALS (owner, 2026-10-04): ESC-discard while the turn is
 * still working.
 *
 * Mid-turn the record's live state is durable per commit, but the dismissal
 * still cannot validate against a half-run transcript — the ROUTE parks the
 * intent and answers 202; the run's settle path applies it against the
 * completed record. Validation runs at APPLY time: if the dismissed
 * question/problem really is pending there, the dismissal lands exactly as
 * the route would have written it; if it never materialized (the call
 * errored, the model re-posed and answered), the park is dropped silently.
 *
 * Lives on globalThis — the same module instance discipline as
 * turn-liveness: the dismiss route and the chat-handler entry must see the
 * SAME registry. Ephemeral by design; one parked dismissal per chat (last
 * write wins — there is one dock, one discard).
 */

import { ChatInputError } from "./model/input-events.ts";
import type { DismissInput } from "./model/input-events.ts";
import { writeDismissal } from "./turn-service.ts";

interface LhGlobal {
	__lhParkedDismissals?: Map<string, DismissInput>;
}

function registry(): Map<string, DismissInput> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhParkedDismissals ??= new Map());
}

/** Park (or overwrite) the chat's dismissal intent. Called by the dismiss
 *  route when a turn owns the chat. */
export function parkDismissal(chatId: string, input: DismissInput): void {
	registry().set(chatId, input);
}

/** Take the chat's parked dismissal (removes it). Returns null when
 *  nothing is parked. */
export function takeParkedDismissal(chatId: string): DismissInput | null {
	const parked = registry().get(chatId);
	if (parked === undefined) return null;
	registry().delete(chatId);
	return parked;
}

/** Apply the chat's parked dismissal, if any, against the current record.
 *  Runs in the turn's onFinish, AFTER the run's entries committed and
 *  BEFORE the settle events — a client reacting to "turn-settled" reads the
 *  dismissal already in the record. A ChatInputError means the dismissed
 *  thing never materialized — the park is dropped silently. Any other write
 *  failure keeps the park for the next settle. */
export async function applyParkedDismissal(chatId: string): Promise<boolean> {
	const parked = registry().get(chatId);
	if (parked === undefined) return false;
	try {
		await writeDismissal(chatId, parked);
	} catch (err) {
		if (err instanceof ChatInputError) {
			if (registry().get(chatId) === parked) registry().delete(chatId);
			return false;
		}
		throw err;
	}
	if (registry().get(chatId) === parked) registry().delete(chatId);
	return true;
}
