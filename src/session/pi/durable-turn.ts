/**
 * THE DURABLE TURN RUNNER (pi-durable migration, foreground unit).
 *
 * A turn is a durable run: `submit()` admits the input in one commit, the
 * Harness runs generation + tools on the chat's SQLite database, and every
 * partial answer, tool slot, and transcript entry lands through a commit.
 * This module is the VIEW layer onto that run — it translates the
 * conversation's committed structural view into the app's existing SSE
 * dialect (full partial `message_update`, `tool_execution_*`,
 * `turn_end.toolResults`, `agent_start`/`agent_end`), so the browser keeps
 * one protocol and one replace-by-slot rule.
 *
 * The wire contract is unchanged on purpose: the client replaces a streaming
 * assistant with `event.message`, ignores question placeholders, and appends
 * a round's tool results on `turn_end`. Assistant `message_end` events carry
 * NO app id — the streaming slot keeps the id it minted; the settle refetch
 * lands the record's ids.
 *
 * A turn executes decoupled from any single HTTP response: the POST acks and
 * closes, every view attaches through GET /api/chats/[id]/stream. The
 * in-memory log is the replay buffer for reattaching views (settled events
 * verbatim, the latest snapshot per in-flight message/tool call), and the
 * durable transcript is the truth behind it.
 */

import { SSE_HEADERS } from "../../platform/index.ts";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
	ConversationView,
	EntryId,
	EntryRecord,
	LiveState,
	Submission,
	ToolSlot,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ChatRuntime } from "../durable.ts";

/** The wire event: the app's existing dialect (see the file header). */
export type TurnWireEvent =
	| { type: "agent_start" }
	| { type: "message_start"; message: Message }
	| { type: "message_update"; message: Message }
	| { type: "message_end"; message: Message }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult?: unknown }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			isError: boolean;
			result: { content: Array<{ type: "text"; text: string }>; details?: unknown };
	  }
	| { type: "turn_end"; toolResults: ToolResultMessage[] }
	| { type: "agent_end" }
	| { type: "error"; errorText: string };

/** One view onto a running turn. */
interface PiTurnSubscriber {
	push(event: TurnWireEvent): void;
	done(): void;
}

/** The server-side turn object: a reattachable, abortable view of one run. */
export interface PiTurnHandle {
	subscribe(): ReadableStream<Uint8Array>;
	abort(): void;
}

interface DurableTurnSpec {
	runtime: ChatRuntime;
	/** The admitted submission this view follows. Its settlement is the
	 *  run's own end; a queued steer that starts a follow-up run is awaited
	 *  after it (waitForIdle), so a steer racing the run's end still lands
	 *  on this wire. */
	submission?: Submission;
	/** The last entry committed BEFORE the run was admitted. A view of a
	 *  RECOVERED run starts after it: the client already holds the record's
	 *  older projection, so replaying the whole chat would duplicate it. An
	 *  entry id (not a count) survives the active-view head marker compaction
	 *  writes before admission. */
	replayAfter?: EntryId;

	/** The canonical settle seam: usage, plan blocks, extraction, parked
	 *  dismissal. AWAITED before views close, so a reader that sees the
	 *  terminal always finds the record and the job bookkeeping current. */
	onFinish: () => void | Promise<void>;
	/** One callback per newly committed transcript entry (the delivery
	 *  bookkeeping seam: a steer marker's entry is its visibility moment). */
	onEntry?: (entry: EntryRecord) => void;
}

/** The coalescing window for update fan-out (the compaction law): the log
 *  keeps the latest snapshot per in-flight message/tool call, never the
 *  chunk history. */
const UPDATE_FLUSH_MS = 100;

export function runDurableTurn(spec: DurableTurnSpec): PiTurnHandle {
	const { runtime, submission, onFinish, onEntry } = spec;
	const { chatId } = runtime;

	let settled = false;
	let started = false;
	let streaming = false;
	let lastPartial = "";
	let seenEntries: number | undefined = spec.replayAfter === undefined ? 0 : undefined;
	/** Tool calls of the assistant entry whose results have not all landed. */
	let round: { callIds: string[]; results: ToolResultMessage[] } | null = null;
	const startedSlots = new Set<string>();
	const slotOutput = new Map<string, string>();

	const log: TurnWireEvent[] = [];
	const updateSlots = new Map<string, number>();
	const pending = new Map<string, TurnWireEvent>();
	const subscribers = new Set<PiTurnSubscriber>();

	const coalesceKey = (event: TurnWireEvent): string | null => {
		if (event.type === "message_update") return "message";
		if (event.type === "tool_execution_update") return `tool:${event.toolCallId}`;
		return null;
	};

	const send = (event: TurnWireEvent) => {
		if (settled) return;
		const key = coalesceKey(event);
		if (key !== null) {
			const idx = updateSlots.get(key);
			if (idx !== undefined) log[idx] = event;
			else {
				updateSlots.set(key, log.length);
				log.push(event);
			}
			pending.set(key, event);
			armFlush();
			return;
		}
		if (event.type === "message_end") updateSlots.delete("message");
		if (event.type === "tool_execution_end") updateSlots.delete(`tool:${event.toolCallId}`);
		flushPending();
		log.push(event);
		for (const sub of subscribers) sub.push(event);
	};

	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	const flushPending = () => {
		if (flushTimer !== undefined) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		if (pending.size === 0) return;
		const batch = [...pending.values()];
		pending.clear();
		for (const sub of subscribers) for (const event of batch) sub.push(event);
	};
	const armFlush = () => {
		if (flushTimer !== undefined) return;
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			flushPending();
		}, UPDATE_FLUSH_MS);
		(flushTimer as { unref?: () => void }).unref?.();
	};
	const closeAll = () => {
		if (settled) return;
		flushPending();
		settled = true;
		for (const sub of subscribers) sub.done();
		subscribers.clear();
	};

	const start = () => {
		if (started) return;
		started = true;
		send({ type: "agent_start" });
	};

	/** Translate newly committed entries into wire events. */
	const advanceEntries = (entries: readonly EntryRecord[]) => {
		if (seenEntries === undefined) {
			const at = entries.findIndex((entry) => entry.id > spec.replayAfter!);
			seenEntries = at < 0 ? entries.length : at;
		}
		for (const entry of entries.slice(seenEntries)) {
			onEntry?.(entry);
			// App-authored records (job steers, handoffs, thinking traces,
			// the learner's composer steer) travel as UPSERTED messages keyed
			// by their record id.
			const marker = (entry.data as { message?: { role?: string } } | undefined)?.message;
			if (marker && marker.role !== "assistant") {
				send({ type: "message_start", message: marker as Message });
				send({ type: "message_end", message: marker as Message });
				continue;
			}
			const message = entry.model?.[0] as { role?: string } | undefined;
			if (message?.role === "assistant") {
				const assistant = message as AssistantMessage;
				start();
				// A response whose partials never committed (an instant
				// provider answer, the scripted tests) still travels the
				// protocol the client's tool-call shimmer keys on: the full
				// message is seen in a start+update before the end.
				if (!streaming) {
					send({ type: "message_start", message: assistant });
					send({ type: "message_update", message: assistant });
				}
				streaming = false;
				lastPartial = "";
				send({ type: "message_end", message: assistant });
				const callIds = assistant.content
					.filter((block) => block.type === "toolCall")
					.map((block) => block.id);
				round = callIds.length > 0 ? { callIds, results: [] } : null;
				continue;
			}
			if (message?.role === "toolResult") {
				const result = message as ToolResultMessage;
				send({
					type: "tool_execution_end",
					toolCallId: result.toolCallId,
					toolName: result.toolName,
					isError: result.isError === true,
					result: {
						content: (result.content ?? []) as Array<{ type: "text"; text: string }>,
						details: result.details,
					},
				});
				if (round?.callIds.includes(result.toolCallId)) {
					round.results.push(result);
					if (round.results.length === round.callIds.length) {
						send({ type: "turn_end", toolResults: round.results });
						round = null;
					}
				}
			}
		}
		seenEntries = Math.max(seenEntries, entries.length);
	};

	const advance = (view: ConversationView) => {
		const live = view.docs["pi.live"] as LiveState | undefined;
		if (live?.run || live?.generation) start();

		const partial = live?.generation?.message as AssistantMessage | undefined;
		if (partial) {
			const json = JSON.stringify(partial);
			if (json !== lastPartial) {
				lastPartial = json;
				send({ type: streaming ? "message_update" : "message_start", message: partial });
				streaming = true;
			}
		}

		advanceEntries(view.entries);

		for (const slot of (live?.tools ?? []) as ToolSlot[]) {
			if (slot.status === "running" && !startedSlots.has(slot.callId)) {
				startedSlots.add(slot.callId);
				send({ type: "tool_execution_start", toolCallId: slot.callId, toolName: slot.name });
			}
			const output = slot.output ?? "";
			if (slot.status === "running" && output !== (slotOutput.get(slot.callId) ?? "")) {
				slotOutput.set(slot.callId, output);
				send({
					type: "tool_execution_update",
					toolCallId: slot.callId,
					toolName: slot.name,
					partialResult: output,
				});
			}
		}

	};

	let settling: Promise<void> | undefined;
	const settle = () => {
		settling ??= (async () => {
			// A closing runtime hands the run to durable recovery: the next
			// process owns the settle services, and this one must not bill or
			// notify a run it cannot finish (nor mask the close as a turn error).
			if (runtime.closing) {
				closeAll();
				return;
			}
			// The terminal commit must be on the wire before [DONE]: a view
			// that attaches late would otherwise miss the final message.
			const final = await runtime.root.context(BACKGROUND_CONTEXT).catch(() => undefined);
			if (final) advanceEntries(final.entries);
			start();
			await onFinish();
			send({ type: "agent_end" });
			closeAll();
		})();
		return settling;
	};

	void (async () => {
		try {
			const watch = await runtime.root.watch(BACKGROUND_CONTEXT);
			watch.start(async (value) => {
				advance(value);
			});
			advance(watch.value);
			// The submission settles with its run; waitForIdle then absorbs a
			// follow-up run a queued steer started (the steer-race case), so
			// the view never closes while the conversation still works.
			if (submission) await submission.wait(BACKGROUND_CONTEXT);
			await runtime.root.waitForIdle(BACKGROUND_CONTEXT);
			await settle();
			await watch.stop().catch(() => undefined);
		} catch (error) {
			if (runtime.closing) {
				// The run stays recoverable from its committed state; the next
				// process resumes and settles it.
				closeAll();
				return;
			}
			console.error(`[chat ${chatId}] durable turn view failed:`, error);
			if (!settled) {
				send({ type: "error", errorText: "An error occurred." });
				await settle().catch(() => undefined);
			}
		}
	})();

	return {
		subscribe() {
			let sub: PiTurnSubscriber | undefined;
			return new ReadableStream<Uint8Array>({
				start(controller) {
					const encoder = new TextEncoder();
					let closed = false;
					sub = {
						push(event) {
							if (closed) return;
							try {
								controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
							} catch {
								closed = true;
							}
						},
						done() {
							if (closed) return;
							closed = true;
							try {
								controller.enqueue(encoder.encode("data: [DONE]\n\n"));
								controller.close();
							} catch {
								/* already cancelled */
							}
						},
					};
					subscribers.add(sub);
					for (const event of log) sub.push(event);
					if (settled) sub.done();
				},
				cancel() {
					// A view leaving NEVER kills the turn.
					if (sub) subscribers.delete(sub);
				},
			});
		},
		abort() {
			if (settled) return;
			void runtime.root.abort(BACKGROUND_CONTEXT).catch((error) => {
				console.error(`[chat ${chatId}] turn abort failed:`, error);
			});
		},
	};
}

/** The subscriber-shaped SSE response (GET /api/chats/[id]/stream). */
export function piTurnResponse(handle: PiTurnHandle): Response {
	return new Response(handle.subscribe(), {
		headers: SSE_HEADERS,
	});
}
