/**
 * THE WAKE PIPELINE (contracts.ts "THE ASYNC PROTOCOL" §4) — server-side
 * steer delivery for finished sub-agent jobs. One registry, two vehicles:
 *
 *   deliverJobResult(chatId, steer) — the runner calls this on job completion. The
 *     steer joins a per-chat serialized registry and the pump drives it:
 *
 *       1. LIVE RUN → the durable inbox. The marker is submitted to the
 *          chat's running conversation (a model-context write); the Harness
 *          places it at the next turn boundary INSIDE the same run, so the
 *          lesson continues mid-flight and the entry lands in the record.
 *          The delivery promise settles when that entry commits (the view
 *          calls markSteerDelivered) or at settlement (settleSteers).
 *          probe-handoff markers NEVER take this path (owner ruling: the
 *          handoff must start the TEACHER's run — a record-level branch
 *          only a fresh wake can make).
 *       2. IDLE WAKE: no live run. WAIT FOR IDLE (a running turn OR a
 *          pending question — the learner owns the next move), then fire
 *          ONE server-side wake turn carrying EVERY queued marker as its
 *          input appends (the same composition as a client request). A 409
 *          means a client turn raced in — re-queue and retry with backoff.
 *          Idempotent per steer id (steerDelivered): a crashed wake or a
 *          duplicate deliver is skipped, not duplicated.
 *
 *   settleSteers(chatId, record) — the settle reconciliation: markers whose
 *     entry committed resolve; the rest return to pending and the pump
 *     retries through the gates.
 *
 *   Crash recovery (recoverStaleJobs): a process restart can orphan jobs —
 *     "running" with a result (the wake never fired) or without one (the
 *     sub-agent loop itself died). The sweep re-delivers finished results
 *     (idempotently) and re-spawns unfinished loops, both via injected
 *     seams. It runs once at boot.
 */

import { processState } from "../platform/model/index.ts";
import { buildAbortSteer, buildSubagentSteer, isJobFailure, steerDelivered, type JobRecord, type JobResult, type SteerMessage } from "./model/types.ts";
import type { TurnInput } from "../session/model/index.ts";
import { danglingQuestionOf, endsInDismissal, modelTextOf, type LhMessage } from "../session/model/index.ts";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { fireJobAbort, isJobLive } from "./aborts.ts";
import { stores } from "../stores.ts";
import { isCommittedRunLive, isTurnRunning } from "../session/index.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openChatRuntime } from "../session/index.ts";
import { abortBackgroundRun } from "./runtime.ts";

/** Fires one server-side teacher turn: (chatId, input) → HTTP-ish status.
 *  Wave C: the input is the IDLE WAKE — every queued marker as the turn's
 *  input appends (the handler appends them natively under the wake's own
 *  turn claim; one composition for every turn). */
export type TurnRunner = (chatId: string, input: TurnInput) => Promise<number>;

/** Re-runs a job's sub-agent loop (crash recovery for orphaned jobs). */
export type JobRespawn = (jobId: string) => void;

interface QueuedSteer {
	steer: SteerMessage;
	resolve: () => void;
	reject: (reason: Error) => void;
	/** The marker was submitted to a live run's durable inbox. Guards a
	 *  double submission while that run is live; CLEARED at settlement for
	 *  markers the run never reached (they go back through the pump). */
	submitted?: boolean;
	/** The marker's entry committed — the runner's delivery promise settled. */
	delivered?: boolean;
}

interface WakeState {
	turnRunner?: TurnRunner;
	respawn?: JobRespawn;
	/** chatId → steers awaiting delivery, in arrival order. The single
	 *  delivery registry (Wave C: the agent's own follow-up queue is a
	 *  per-run VEHICLE, not the registry — settlement reconciles here). */
	queues: Map<string, QueuedSteer[]>;
	/** Chats whose pump loop is currently active (serialization per chat). */
	pumping: Set<string>;
}

function state(): WakeState {
	return processState<WakeState>("wakePipeline", () => ({ queues: new Map(), pumping: new Set() }));
}

/** chat-handler wires this at module init: its adapter around handleChatRequest. */
export function setTurnRunner(run: TurnRunner): void {
	state().turnRunner = run;
}

/** chat-handler wires this at module init: its job runner's runJob. */
export function setJobRespawn(respawn: JobRespawn): void {
	state().respawn = respawn;
}

const POLL_MS = 400;
/** After the gates open, wait a beat before firing — a client that just
 *  answered a question is about to send its continuation; don't 409 it.
 *
 *  Evidence for 750: the race window is exactly the learner's answer→POST
 *  flight — sendAutomaticallyWhen dispatches synchronously on addToolOutput,
 *  the answer hits the record only at the write-ahead persist, and beginTurn
 *  flips the turn registry immediately after, all before the grace can fire
 *  (measured localhost RTT ~10ms; typical LAN/production RTT <300ms). 750ms
 *  is 2.5× the worst realistic flight. A miss self-heals: the pump rechecks
 *  the gates after the grace AND the wake pipeline retries 409s with a
 *  backoff ramp — and since the transport's merge-retry (chat-transport.ts)
 *  made client 409s non-fatal, even a pathological RTT degrades gracefully.
 *  (Was 1500 — pure guess; 750 claws back 750ms of post-answer delivery
 *  latency without weakening the guard.) */
const GRACE_MS = 750;
/** 409 backoff: capped ramp so a busy client can't spin the pump. */
const RETRY_BACKOFF_MS = [500, 1000, 2000, 5000] as const;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The job a steer belongs to, if it is a job steer (result/abort);
 *  probe-handoff steers have no job — null. */
function jobIdOf(steer: SteerMessage): string | null {
	const details = steer.details as { jobId?: string } | undefined;
	return typeof details?.jobId === "string" ? details.jobId : null;
}

/** Dock bookkeeping: the marker reached the learner's view — flip its job
 *  NOW instead of waiting for the delivering turn to settle. Called from
 *  BOTH visibility seams: the marker's message_end wire event (live steer
 *  injection — the card is on screen while the teacher keeps teaching) and
 *  the write-ahead persist in handleChatInput (the wake's input appends —
 *  the card is durable in the record). The registry's delivery promise
 *  still settles via settleSteers / the runner-200 path; finalizeJob is
 *  idempotent, so the later flip is a no-op. Owner ruling (2026-09-26): a
 *  delivered subagent leaves the background dock the moment its result is
 *  visible, not when the teacher's turn ends. */
export function noteSteerVisible(steer: SteerMessage): void {
	finalizeSteer(steer);
}

/** Finalize a delivered steer's job bookkeeping — job steers only. */
function finalizeSteer(steer: SteerMessage): void {
	const jobId = jobIdOf(steer);
	if (jobId) finalizeJob(jobId);
}

/** Fail a steer's job on unrecoverable delivery failure — job steers only. */
function failSteer(steer: SteerMessage, err: Error): void {
	const jobId = jobIdOf(steer);
	if (jobId) failJob(jobId, err);
}

/** Queue ANY steer (result, abort, probe handoff) through the pipeline.
 *  Resolves when the wake turn has completed; rejects when delivery fails
 *  unrecoverably. Never rejects for queueing itself. */
export function deliverJobResult(chatId: string, steer: SteerMessage): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const s = state();
		const queue = s.queues.get(chatId) ?? [];
		queue.push({ steer, resolve, reject });
		s.queues.set(chatId, queue);
		void pump(chatId);
	});
}

/** Submit one pending marker into the chat's LIVE run through the durable
 *  inbox (a model-context write: the Harness places it at the next turn
 *  boundary inside the same run). The committed run check and the inbox
 *  enqueue are ONE transaction, so a run that settles in between can never
 *  turn the steer into a new run with no handle and no usage settlement.
 *  Returns false when no committed run is live. Idempotent by the steer's
 *  deterministic request id. */
async function submitSteer(chatId: string, steer: SteerMessage): Promise<boolean> {
	const runtime = await openChatRuntime(chatId);
	return runtime.root.commit(async (tx) => {
		if ((await tx.doc(LiveDoc, runtime.root.id)).run === undefined) return false;
		if (await tx.submissionByRequest(runtime.root.id, steer.id)) return true;
		const submission = await tx.createSubmission({
			conversationId: runtime.root.id,
			requestId: steer.id,
			type: "input",
			status: "queued",
		});
		const inbox = await tx.doc(InboxDoc, runtime.root.id);
		inbox.items.push({
			id: submission.id,
			mode: "steer",
			content: (modelTextOf(steer) ?? steer.content) as never,
			entry: { kind: "lh.marker", data: { message: steer } } as never,
		});
		return true;
	}, BACKGROUND_CONTEXT);
}

/** The steer route's live hand-off (composer steering, 2026-10-03): a
 *  learner message for a RUNNING turn becomes a durable inbox input — the
 *  run reads it at its next boundary and the record keeps it. False means
 *  no committed run is live (the caller 409s and the client falls back to
 *  a plain text send); the inbox admission is atomic with that check. */
export async function steerLiveChat(chatId: string, message: LhMessage): Promise<boolean> {
	return submitSteer(chatId, message as SteerMessage);
}

/** A marker the run actually delivered (its entry committed): flip the job
 *  and resolve the waiting runner. Called by the turn view on each newly
 *  committed marker entry, so the dock card leaves at visibility. */
export function markSteerDelivered(chatId: string, steerId: string): void {
	const queue = state().queues.get(chatId);
	if (!queue) return;
	const entry = queue.find((e) => e.steer.id === steerId && !e.delivered);
	if (!entry) return;
	entry.delivered = true;
	finalizeSteer(entry.steer);
	entry.resolve();
	state().queues.set(
		chatId,
		queue.filter((e) => !e.delivered),
	);
}

/** Restart the pump for a chat (a run settled; its leftover markers must go
 *  back through the gates). Idempotent: one pump loop per chat. */
export function repumpSteers(chatId: string): void {
	void pump(chatId);
}

/** TURN SETTLEMENT RECONCILIATION: markers whose id the settled record now
 *  carries are delivered (resolve + flip); the rest return to PENDING so
 *  the pump's next pass can wake them with the record current. */
export function settleSteers(chatId: string, persisted: { id?: string }[]): void {
	const queue = state().queues.get(chatId);
	if (!queue || queue.length === 0) return;
	const deliveredIds = new Set(persisted.map((m) => m.id).filter(Boolean));
	const remaining: QueuedSteer[] = [];
	for (const entry of queue) {
		if (deliveredIds.has(entry.steer.id)) {
			if (!entry.delivered) {
				entry.delivered = true;
				finalizeSteer(entry.steer);
				entry.resolve();
			}
			continue;
		}
		entry.submitted = undefined;
		remaining.push(entry);
	}
	if (remaining.length === 0) state().queues.delete(chatId);
	else {
		state().queues.set(chatId, remaining);
		void pump(chatId);
	}
}

/** Result of an abort attempt — the endpoint maps these to HTTP. */
export interface AbortOutcome {
	ok: boolean;
	reason?: "not_found" | "not_running";
}

/**
 * ABORT (2026-09 dock semantics, user-decided): real kill, error with
 * reason, the teacher still learns. The dock's END button reaches this
 * through POST /api/activity/abort (body {kind: "job", id: jobId}); the
 * route is master's thin composition — this is the job-side mechanism.
 * Four things happen, in order:
 *
 *   1. RECORD the abort intent before touching the runtime: flip the
 *      record to error "Aborted by learner", so a
 *      failed open still leaves a durable cancellation for the next open
 *      (the poll reflects the user's action at once; the user chose
 *      error-with-reason over a distinct cancelled status). finalizeJob
 *      never overwrites a non-running status, so the flip is terminal no
 *      matter what the wake does.
 *   2. KILL the spend: fire the job's registered AbortController (the
 *      runner registered it at loop start) — the in-flight model call
 *      aborts, not just the next loop check. The runner unwinds silently
 *      (its catch checks abortSignal.aborted; finishJob checks status).
 *   3. DROP any queued result steer for this job (the delivering-result
 *      phase): resolve its entry without firing the wake. If the wake
 *      turn is ALREADY in flight (the pump shifted the entry), it's too
 *      late — the result steer lands, and the cancellation steer dedupes
 *      against it via steerDelivered (same jobId metadata).
 *   4. STEER the teacher: a one-line abort note (buildAbortSteer) through
 *      the same wake pipeline, so the teacher's promise of a result
 *      doesn't hang silently in the lesson.
 *
 * The runner writes the usage folded so far in its finally (merge patch),
 * so an aborted job's money record survives the kill.
 */
export function abortJob(jobId: string): AbortOutcome {
	const job = stores.jobStore.getJob(jobId);
	if (!job) return { ok: false, reason: "not_found" };
	if (job.status !== "running") return { ok: false, reason: "not_running" };

	let killed = false;
	try {
		const persisted = stores.jobStore.updateJob(jobId, {
			status: "error",
			error: "Aborted by learner",
			activity: "aborted",
		});
		if (!persisted) return { ok: false, reason: "not_found" };
	} finally {
		killed = fireJobAbort(jobId);
	}

	// Drop any queued steers for this job (their deliver() resolves unfired).
	// HANDED entries (already in a live run's follow-up queue) are past
	// recall — same ruling as a fired wake: the result lands, and the abort
	// note below dedupes against it via steerDelivered (same jobId).
	const queue = state().queues.get(job.chatId);
	if (queue) {
		const remaining = queue.filter(
			(e) => jobIdOf(e.steer) !== jobId || e.submitted !== undefined,
		);
		if (remaining.length === 0) state().queues.delete(job.chatId);
		else state().queues.set(job.chatId, remaining);
		for (const entry of queue) {
			if (jobIdOf(entry.steer) === jobId && entry.submitted === undefined) entry.resolve();
		}
	}

	// A RECOVERED run has no in-process registration until its loop
	// reattaches: resolve it from the durable index and abort the child
	// directly, or the model keeps streaming after the record says error.
	if (!killed) {
		void abortBackgroundRun(job.chatId, jobId).catch((error) => {
			console.error(`[job ${jobId}] durable abort failed:`, error);
		});
	}
	void deliverJobResult(job.chatId, buildAbortSteer(job)).catch(() => {
		/* deliverJobResult marks the job error on unrecoverable failure */
	});
	return { ok: true };
}

/**
 * The per-chat pump: delivers the registry along pi's two native paths.
 * Only one loop per chat at a time; later arrivals ride the registry.
 *
 * Each iteration first clears dead weight (gone chat, already-delivered
 * markers), then picks the vehicle: a LIVE turn takes every eligible
 * marker via agent.followUp (the run continues at its own stop — nothing
 * more to do here until settlement re-pumps); otherwise the IDLE WAKE
 * fires ONE turn carrying every pending marker as its input appends.
 */
async function pump(chatId: string): Promise<void> {
	const s = state();
	if (s.pumping.has(chatId)) return;
	s.pumping.add(chatId);
	try {
		for (let attempt = 0; ; ) {
			const queue = s.queues.get(chatId);
			if (!queue || queue.length === 0) {
				s.queues.delete(chatId);
				return;
			}

			// Gone chat: nothing to deliver into.
			const record = await stores.chatStore.getChat(chatId);
			// The queue can change across the await (abortJob filters it, a
			// delivery appends): restart with the current one, so a dropped
			// steer is never fired from a stale snapshot.
			if (s.queues.get(chatId) !== queue) continue;
			if (!record) {
				s.queues.delete(chatId);
				for (const entry of queue) {
					entry.reject(new Error(`chat ${chatId} not found — cannot deliver steer ${entry.steer.id}`));
				}
				continue;
			}

			// Idempotent delivery: the transcript already carries these steers
			// (an in-run injection persisted, a wake completed, or a duplicate
			// deliver raced in). Resolve and flip without re-firing anything.
			const stillPending = queue.filter((e) => !steerDelivered(record.messages, e.steer.id));
			for (const entry of queue) {
				if (!stillPending.includes(entry)) {
					finalizeSteer(entry.steer);
					entry.resolve();
				}
			}
			if (stillPending.length === 0) {
				s.queues.delete(chatId);
				return;
			}
			s.queues.set(chatId, stillPending);

			// VEHICLE 1 — THE LIVE RUN's durable inbox. A probe-handoff never
			// rides a live run (it must START the teacher's run); while one is
			// pending, wait the run out and fall through to the idle wake.
			if (await isCommittedRunLive(chatId)) {
				const handoffWaits = stillPending.some((e) => e.steer.customType === "probe-handoff");
				const riders = stillPending.filter((e) => e.steer.customType !== "probe-handoff");
				let allAdmitted = true;
				for (const entry of riders) {
					if (entry.submitted) continue;
					if (!(await submitSteer(chatId, entry.steer))) {
						allAdmitted = false;
						break;
					}
					entry.submitted = true;
				}
				// A run that settled between the check and the transaction is
				// NOT a steer: re-enter through the claim-aware idle wake.
				if (!allAdmitted) {
					await delay(POLL_MS);
					continue;
				}
				if (riders.length > 0 && !handoffWaits) return; // the run delivers
				await delay(POLL_MS);
				await waitForIdle(chatId);
				continue;
			}

			// VEHICLE 2 — THE IDLE WAKE: one server-side turn carrying EVERY
			// pending marker as its input appends (the handler write-ahead
			// persists them under the wake's own turn claim).
			await waitForIdle(chatId);

			// Re-fetch AFTER the gates open — waitForIdle can wait out a quiz
			// answer (minutes), and sending the pre-wait snapshot would clobber
			// the client's answer + continuation in the write-ahead persist.
			const fresh = await stores.chatStore.getChat(chatId);
			// The installed array is `stillPending` (set above), not the
			// snapshot this iteration started from: compare against what the
			// pump actually published.
			if (s.queues.get(chatId) !== stillPending) continue;
			if (!fresh) {
				continue; // the gone-chat branch rejects next iteration
			}

			// The runner is required — chat-handler sets it at init. If some
			// module instance missed the wiring, fail loudly rather than hang.
			if (!s.turnRunner) {
				s.queues.delete(chatId);
				const err = new Error("wake pipeline: no turn runner wired (setTurnRunner)");
				for (const entry of stillPending) {
					failSteer(entry.steer, err);
					entry.reject(err);
				}
				return;
			}

			// A live run may have delivered some markers while the gates were
			// closed — re-check: only still-missing markers ride the wake.
			const fire = stillPending.filter((e) => !steerDelivered(fresh.messages, e.steer.id));
			for (const entry of stillPending) {
				if (!fire.includes(entry)) {
					finalizeSteer(entry.steer);
					entry.resolve();
				}
			}
			if (fire.length === 0) {
				s.queues.delete(chatId);
				return;
			}

			// THE DISMISSAL PAUSE (owner design 2026-10-03, "A2"): the record
			// ends in a user dismissal — the session waits for the USER. Hold
			// every marker in the queue (no wake fires) and return; the user's
			// next send is the wake that carries them (the in-run vehicle below
			// hands them to that turn once the text-claim lands — until then,
			// settlement re-pumps and lands them right after it). The pause is
			// derived from the tail, so any user message un-holds by construction.
			if (endsInDismissal(fresh.messages)) {
				return;
			}

			// DEQUEUE-AT-FIRE (the Wave C lesson from the Wave B regression):
			// the carried markers leave the registry BEFORE the turn runs —
			// the wake run's OWN follow-up poll must never see its own cargo,
			// and a 409 (client raced in) must be able to push them back.
			s.queues.delete(chatId);
			const steers = fire.map((e) => e.steer);

			// Fire the wake (every marker as the turn's input appends). A 409 =
			// a client turn raced in between idle and firing — push the cargo
			// back and retry after backoff (the racing turn's own settlement
			// re-pumps if it beats us to the re-queue).
			const status = await s.turnRunner(chatId, { type: "steers", steers }).catch((err: unknown) => {
				console.error(`[steer ${steers.map((x) => x.id).join(",")}] wake turn crashed:`, err);
				return -1;
			});
			if (status === 409) {
				const back = s.queues.get(chatId) ?? [];
				back.push(...fire);
				s.queues.set(chatId, back);
				await delay(RETRY_BACKOFF_MS[Math.min(attempt++, RETRY_BACKOFF_MS.length - 1)]!);
				continue;
			}
			attempt = 0;

			if (status === 200) {
				for (const entry of fire) {
					finalizeSteer(entry.steer);
					entry.resolve();
				}
			} else {
				const err = new Error(`wake turn failed with status ${status}`);
				for (const entry of fire) {
					failSteer(entry.steer, err);
					entry.reject(err);
				}
			}
		}
	} finally {
		s.pumping.delete(chatId);
		// A steer may have arrived between the last check and the finally —
		// restart the pump rather than strand it. Entries already handed to
		// a live run are NOT stragglers (settleSteers owns their resurrection)
		// — restarting for them would just park in waitForIdle forever.
		const q = state().queues.get(chatId) ?? [];
		if (q.some((e) => e.submitted === undefined)) void pump(chatId);
	}
}

/** Flip the job to its final status now that the lesson has resumed. */
function finalizeJob(jobId: string): void {
	const job = stores.jobStore.getJob(jobId);
	if (!job || job.status !== "running") return;
	const result = job.result;
	const failed = result ? isJobFailure(result as JobResult) : true;
	stores.jobStore.updateJob(jobId, {
		status: failed ? "error" : "done",
		activity: failed ? "failed" : "delivered",
	});
}

function failJob(jobId: string, err: Error): void {
	// An aborted job stays aborted even when its (abort) steer
	// delivery fails — the user's action is the terminal fact, not the
	// delivery error. Non-running records are never overwritten here.
	const job = stores.jobStore.getJob(jobId);
	if (!job || job.status !== "running") return;
	stores.jobStore.updateJob(jobId, { status: "error", error: err.message, activity: "delivery failed" });
}

/**
 * Wait until the chat can take a wake turn: no turn in flight AND no
 * unanswered question call (the record's dangling question — the answer
 * arrives as its tool result, and no turn may run in the window). Poll;
 * the learner may take arbitrarily long to answer, and that is correct —
 * the steer fires right after their answer turn completes.
 */
async function waitForIdle(chatId: string): Promise<void> {
	for (;;) {
		const record = await stores.chatStore.getChat(chatId);
		if (!record) return;
		const blocked = (await isTurnRunning(chatId)) || danglingQuestionOf(record.messages) !== null;
		if (!blocked) {
			await delay(GRACE_MS);
			const recheck = await stores.chatStore.getChat(chatId);
			if (
				!(await isTurnRunning(chatId)) &&
				recheck &&
				danglingQuestionOf(recheck.messages) === null
			) {
				return;
			}
		}
		await delay(POLL_MS);
	}
}

// ─── crash recovery ──────────────────────────────────────────────────────────

/**
 * Boot-time sweep, LIVENESS-GATED
 * (accuracy wave, 2026-09-19): a "running" record without a live loop
 * registration (subagents/aborts.ts) is an orphan of a process death —
 * re-deliver its stored result (idempotently) or re-spawn the loop, at
 * once (the old 15-minute age heuristic waited on ghosts AND re-ran
 * hung-but-alive loops beside themselves — the figure-maker incident,
 * 2026-09-18). A record WITH a live registration is provably executing
 * in THIS process — never touched, however old: a hung first model call
 * (zero usage ever billed) stays honestly "running" in the dock until
 * END kills it. The abort registration spans loop start to delivery
 * completion, so a live registration can never belong to a dead run.
 */
export async function recoverStaleJobs(): Promise<void> {
	const s = state();
	try {
		for (const chat of await stores.chatStore.listChats()) {
			for (const job of stores.jobStore.listJobs(chat.id)) {
				if (job.status !== "running") continue;
				if (isJobLive(job.id)) continue; // provably executing here — never re-run beside it
				if (!(await stores.chatStore.getChat(job.chatId))) continue;
				if (await isTurnRunning(job.chatId)) continue; // a wake turn may be delivering it right now
				if (job.result) {
					// The wake never fired (or crashed mid-flight): re-deliver.
					const steer = buildSubagentSteer(job, job.result as JobResult);
					stores.jobStore.updateJob(job.id, { activity: "recovering: re-delivering" });
					void deliverJobResult(job.chatId, steer).catch(() => {
						/* deliverJobResult marks the job error on failure */
					});
				} else {
					// The sub-agent loop itself died with the process: re-spawn.
					if (!s.respawn) continue;
					stores.jobStore.updateJob(job.id, { activity: "recovering: re-running" });
					s.respawn(job.id);
				}
			}
		}
	} catch (err) {
		console.error("[jobs] stale-job recovery sweep failed:", err);
	}
}

export function listJobs(chatId: string): JobRecord[] {
	return stores.jobStore.listJobs(chatId);
}
