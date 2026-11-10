/**
 * Job abort registry — WHO can actually kill a running sub-agent.
 *
 * The runner creates one AbortController per running job and registers it
 * here; the abort path (wake.ts abortJob, driven by the dock's END button
 * via POST /api/activity/abort) fires it through fireJobAbort.
 *
 * Abort semantics (owner decision): REAL KILL, not mark-and-abandon — the
 * controller aborts the in-flight model call; headless tool runs are
 * best-effort (the next model call is where a hung one dies). abortJob owns
 * the bookkeeping (status error "Aborted by learner" + the abort steer); the
 * runner only unwinds.
 */

import { processState } from "../platform/model/index.ts";

function registry(): Map<string, AbortController> {
	return processState("jobAborts", () => new Map<string, AbortController>());
}

/** The runner registers its controller at job start (idempotent overwrite). */
export function registerJobAbort(jobId: string, controller: AbortController): void {
	registry().set(jobId, controller);
}

/** The runner unregisters in its finally block (job settled or unwound). */
export function unregisterJobAbort(jobId: string): void {
	registry().delete(jobId);
}

/** True while the job's loop is EXECUTING (a controller is registered) —
 *  the liveness gate for the stale-job sweep: a "running" record with a
 *  live registration belongs to a loop this process owns (hung or slow, it
 *  is the one truth — never re-spawn beside it); without one the record is
 *  an orphan of a process death and recovers immediately. The span is
 *  loop-start to delivery-completion: the runner's unregistering finally
 *  runs only after deliver() resolves, by which point finalizeJob has
 *  flipped the record — so absence of registration is unambiguous. */
export function isJobLive(jobId: string): boolean {
	return registry().has(jobId);
}

/** Abort a running job's loop. Returns false when no controller is live —
 * the job's loop is not executing (crashed, or in the delivering-result
 * phase where the runner has already returned); the caller then owns the
 * whole abort on the record side. */
export function fireJobAbort(jobId: string): boolean {
	const controller = registry().get(jobId);
	if (!controller) return false;
	registry().delete(jobId);
	controller.abort();
	return true;
}
