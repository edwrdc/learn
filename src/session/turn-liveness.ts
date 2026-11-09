/**
 * Turn liveness for the durable foreground runtime.
 *
 * TWO FACTS, ONE AUTHORITY EACH:
 *
 *  - BUSY (what every reader asks — the session list, the chat page, the
 *    abort gate, the delete gate, the dismiss route) is the COMMITTED run
 *    state: a conversation's `pi.live.run` is written by the same commit
 *    that admits the input and cleared by the commit that ends the run.
 *    Nothing in memory can disagree with it, and a process restart cannot
 *    leave a stale flag behind. Reads go through an open runtime only —
 *    a chat nobody has opened cannot be running in this process.
 *
 *  - THE REQUEST MUTEX (writes): two POSTs arriving in one process must not
 *    both write-ahead and then race the durable admission. `beginTurn`
 *    claims the chat before the write-ahead; `endTurn` releases it at
 *    settle. `submit({whenBusy:"reject"})` is the durable half of the same
 *    law (ConversationBusy → 409), so a lost mutex is never silent.
 *
 * Events stay here because the client's notify-then-fetch contract rides
 * them: `turn-started` once the run is admitted, `turn-settled` only after
 * the settle services made the record current.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { emit } from "../platform/model/index.ts";
import { peekChatRuntime } from "./durable.ts";

interface LhGlobal {
	__lhTurnClaims?: Map<string, number>;
}

function claims(): Map<string, number> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhTurnClaims ??= new Map<string, number>());
}

/** A claim older than this is a leak guard for a pathological turn whose
 *  settle never fired. Real turns are minutes at most. */
const MAX_TURN_MS = 30 * 60_000;

/** Claim the chat for the coming turn. Returns false when this process
 *  already owns a turn for it. */
export function beginTurn(chatId: string): boolean {
	const map = claims();
	const since = map.get(chatId);
	if (since !== undefined && Date.now() - since <= MAX_TURN_MS) return false;
	map.set(chatId, Date.now());
	return true;
}

/** Release the claim at settle (or on a failed start). */
export function endTurn(chatId: string): void {
	claims().delete(chatId);
}

/** Is a turn running for this chat? THE reader contract: the committed run
 *  state of the chat's durable conversation, plus this process's admission
 *  claim (the settle window is still "busy" for readers). */
export async function isTurnRunning(chatId: string): Promise<boolean> {
	const since = claims().get(chatId);
	if (since !== undefined && Date.now() - since <= MAX_TURN_MS) return true;
	return isCommittedRunLive(chatId);
}

/** The committed run only: a claim that outlives its run (the settle
 *  services) is NOT a live run to steer into — an input submitted then would
 *  start an unmanaged run with no turn handle and no usage settlement. */
export async function isCommittedRunLive(chatId: string): Promise<boolean> {
	const pending = peekChatRuntime(chatId);
	if (!pending) return false;
	const runtime = await pending.catch(() => undefined);
	if (!runtime || runtime.closing) return false;
	const live = await runtime.harness
		.snapshot(LiveDoc, runtime.root.id, BACKGROUND_CONTEXT)
		.catch(() => undefined);
	return live?.run !== undefined;
}

/** Announce an admitted run (after the durable commit, so a listener that
 *  attaches reads a live conversation). */
export function noteTurnStarted(chatId: string): void {
	emit("turn-started", { chatId });
}

/** Announce a settled run — called LAST, after usage, plan blocks,
 *  extraction, and parked dismissals made the record current. */
export function noteTurnSettled(chatId: string): void {
	emit("turn-settled", { chatId });
}
