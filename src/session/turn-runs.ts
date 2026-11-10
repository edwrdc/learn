/**
 * The running-turn registry (background-turn runner wave, owner ruling
 * 2026-09-25): chatId → the live PiTurnHandle. THE reattach surface —
 * GET /api/chats/[id]/stream resolves here, and the remote abort
 * (/api/activity/abort, kind "turn") kills through here.
 *
 * Registration lifecycle: the turn registers its handle the moment it
 * starts (after the 409 guard); endTurn drops it with the claim, after the
 * settle services ran — so anything that sees "no running turn" also sees
 * an already-persisted record. The per-chat
 * 409 guard means a chatId can hold at most one handle, and beginTurn's
 * 30-minute TTL bounds the pathological never-settling case the same way
 * it does for the liveness map: if onFinish never fires, the stale entry
 * is overwritten by the next turn's registration (Map.set) and garbage
 * collected — no unbounded leak beyond the same pathology turn-liveness
 * already accepts.
 *
 * App-quit mid-turn (the process dying with an un-persisted turn) is the
 * SAME residual as before the wave: the registry is memory-only, the
 * write-ahead record + liveness TTL recovery cover the next mount.
 */

import { SSE_HEADERS } from "../platform/index.ts";
import { emit, processState } from "../platform/model/index.ts";
import type { PiTurnHandle } from "./pi/durable-turn.ts";

function runs(): Map<string, PiTurnHandle> {
	return processState("turnRuns", () => new Map<string, PiTurnHandle>());
}

/** Register the chat's running turn right after its durable admission and
 *  announce it (a listener that attaches reads a live conversation). One per
 *  chat by construction — the claim guard. */
export function registerTurn(chatId: string, handle: PiTurnHandle): void {
	runs().set(chatId, handle);
	emit("turn-started", { chatId });
}

/** Drop the handle; endTurn calls it with the claim release. */
export function unregisterTurn(chatId: string): void {
	runs().delete(chatId);
}

/** The live turn handle for a chat, or undefined — the subscribe endpoint's
 *  and the abort channel's resolution point. */
export function runningTurn(chatId: string): PiTurnHandle | undefined {
	return runs().get(chatId);
}

/** The remote kill: any client (original sender, reattached viewer, future
 *  surfaces) may stop a running turn. not_running mirrors abortJob's
 *  honest 409 — there was nothing to abort, the caller refetches. */
export function abortTurn(chatId: string): { ok: true } | { ok: false; reason: "not_running" } {
	const handle = runs().get(chatId);
	if (!handle) return { ok: false, reason: "not_running" };
	handle.abort();
	return { ok: true };
}

/** The cheap terminal when GET /api/chats/[id]/stream finds no running
 *  turn (raced settle, or the client checked turnInFlight a beat too
 *  late): a same-dialect SSE response whose single chunk tells the client
 *  "nothing to attach to — the record is current, refetch it". Chosen as
 *  an EVENT (not a status code) so the reattach path consumes ONE wire
 *  protocol end to end. */
export function settledTurnResponse(): Response {
	return new Response('data: {"type":"turn-settled"}\n\ndata: [DONE]\n\n', {
		headers: SSE_HEADERS,
	});
}
