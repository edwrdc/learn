import { isAbortError } from "../platform/model/index.ts";
import type { PiEngine } from "../platform/index.ts";
import type { SearchProvider } from "../tools/model/index.ts";
import { buildSubagentSteer, type JobRecord, type JobResult, type SteerMessage } from "./model/types.ts";
import type { JobInput } from "./tools.ts";
import { registerJobAbort, unregisterJobAbort } from "./aborts.ts";
import type { ModelRole } from "../settings/model/index.ts";
import { MODELS_NOT_CONFIGURED_CODE, ROLE_SLOT, modelsNotConfigured, type ModelSlotName, type ProviderKeyMissing } from "../settings/model/index.ts";
import type { ChatStore } from "../session/model/index.ts";
import type { JobStore } from "./model/ports.ts";
import { JOB_ROLES } from "./roles/registry.ts";
import { runRole } from "./roles/role.ts";

/**
 * The background job runner (contracts.ts "THE ASYNC PROTOCOL" §2–3), created
 * via createJobRunner({ chatStore, jobStore, deliver }) — the composition root
 * (chat-handler) injects the storage ports and the WAKE SEAM (the server-side
 * steer delivery, src/server/jobs.ts); this module never imports an adapter.
 *
 *   runJob(jobId) — runs the kind's sub-agent loop in the background
 *     (the job tools' execute fires this via the spawn seam, fire-and-forget),
 *     updating the job's activity line on every iteration. On completion the
 *     runner builds the STEER MESSAGE (buildSubagentSteer) and hands it to
 *     `deliver`; the wake pipeline fires the server-side teacher turn and
 *     flips the job to done/error when the lesson has actually resumed.
 *
 *   A failed job's result carries `failure` — and it STILL steers, because
 *   the teacher must learn the outcome. If delivery itself fails, the job is
 *   marked error (the learner's activity card shows it).
 */

/** The dispatch-time tool input (from src/agent/tools/jobs.ts schemas). */

interface JobRunnerDeps {
	chatStore: ChatStore;
	jobStore: JobStore;
	/**
	 * Hand a finished job's steer to the wake pipeline — resolves when the
	 * steer is delivered (the wake turn completed and the job status
	 * flipped); rejects when delivery fails unrecoverably.
	 */
	deliver: (chatId: string, steer: SteerMessage) => Promise<void>;
	/** Settings-resolved engine per role (model slots wave, 2026-09-20):
	 *  the role-override → slot chain, read FRESH per job (the server
	 *  wiring passes effectiveSettings-based resolution). Test overrides
	 *  (below) still win. BYOK (owner, 2026-09-22): the chain may end
	 *  EMPTY → undefined; runJob then refuses the spawn honestly instead
	 *  of guessing a model. */
	engineFor?: (role: ModelRole) => PiEngine | undefined;
	/** The search seam (search port wave, 2026-09-20): resolves the LIVE
	 *  provider fresh per job — server/search.ts composition injected by
	 *  the wiring; null = honestly unavailable (the researcher's web_search
	 *  reports it as recoverable text). Absent seam (tests) reads the same;
	 *  research dispatch and web_fetch do not require search credentials. */
	searchProvider?: () => SearchProvider | null;
	/** Key-presence gate (provider-key interlude, 2026-09-25): given the
	 *  resolved engine's provider + the kind's slot tier, return the
	 *  refusal envelope when the provider's key is missing (null = run).
	 *  Injected because the agent layer may not read the key store; absent
	 *  in tests that inject engines directly (test engines never owe a key). */
	providerKeyMissing?: (provider: string, slots: ModelSlotName[]) => ProviderKeyMissing | null;
}

export interface JobRunner {
	/** Run one job's sub-agent loop to completion (background; never throws).
	 *  The tool input rides along from dispatch (the spawn fires mid-stream,
	 *  before the tool part is persisted — only crash-recovery re-spawns
	 *  resolve the input from the transcript). */
	runJob(jobId: string, input?: JobInput): Promise<void>;
}

function refusalOf(envelope: ProviderKeyMissing | null) {
	return envelope ? { code: envelope.code, reason: envelope.error } : null;
}

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
	const { chatStore, jobStore, deliver } = deps;

	/** True while the job may still write terminal state (result, error,
	 * steer). False once abortJob has flipped it to error ("Aborted by
	 * learner") — the runner then unwinds silently; the abort path owns the
	 * record and the abort steer. */
	function stillRunning(jobId: string): boolean {
		return jobStore.getJob(jobId)?.status === "running";
	}

	async function runJob(jobId: string, input?: JobInput): Promise<void> {
		const job = jobStore.getJob(jobId);
		if (!job) {
			console.error(`[job ${jobId}] not found — nothing to run`);
			return;
		}
		if (job.status !== "running") return; // already finished / re-run after crash recovery
		if (!(await chatStore.getChat(job.chatId))) {
			jobStore.updateJob(jobId, { status: "error", error: `Chat not found: ${job.chatId}`, activity: "failed" });
			return;
		}
		const role = JOB_ROLES[job.kind];
		const roleInput = role.input(await resolveInput(job, input));
		// BYOK (owner, 2026-09-22) and the provider-key interlude (2026-09-25):
		// no engine for the kind's tier, or its provider key gone, fails the
		// job like any other failure — the teacher reads the refusal instead
		// of waiting forever on a job it already dispatched.
		const tier = ROLE_SLOT[role.model];
		const engine = deps.engineFor?.(role.model);
		const refusal = !engine
			? { code: MODELS_NOT_CONFIGURED_CODE, reason: `${modelsNotConfigured([tier]).error} (missing: ${tier})` }
			: refusalOf(deps.providerKeyMissing?.(engine.model.provider, [tier]) ?? null);
		if (refusal || !engine) {
			console.info(`[job ${jobId}] refused — ${refusal?.reason}`);
			jobStore.updateJob(jobId, { refusal: refusal?.code });
			await finishJob(jobId, role.failure(roleInput, refusal?.reason ?? ""));
			return;
		}
		const abort = new AbortController();
		registerJobAbort(jobId, abort);
		try {
			jobStore.updateJob(jobId, { activity: role.activity });
			const result = await runRole(role, roleInput, {
				engine,
				run: { chatId: job.chatId, jobId },
				search: deps.searchProvider,
				signal: abort.signal,
				onActivity: (line) => jobStore.updateJob(jobId, { activity: line }),
				onUsage: (usage) => jobStore.updateJob(jobId, { usage }),
			});
			await finishJob(jobId, result);
		} catch (err) {
			// An abort or a runtime close: the abort path owns the record, and a
			// closed run stays recoverable — no failure may be delivered for it.
			if (abort.signal.aborted || isAbortError(err)) return;
			const reason = err instanceof Error ? err.message : String(err);
			await finishJob(jobId, role.failure(roleInput, reason));
		} finally {
			unregisterJobAbort(jobId);
		}
	}

	/** The job's tool input: dispatch passes it directly; a crash-recovery
	 *  re-spawn reads the call's arguments from the transcript. */
	async function resolveInput(job: JobRecord, input: JobInput | undefined): Promise<JobInput | undefined> {
		if (input) return input;
		const chat = await chatStore.getChat(job.chatId);
		for (const m of chat?.messages ?? []) {
			if (m.role !== "assistant") continue;
			for (const block of m.content) {
				if (block.type === "toolCall" && block.id === job.toolCallId) return block.arguments as unknown as JobInput;
			}
		}
		return undefined;
	}

	/**
	 * The tail of every job: store the result, build the steer, hand it to
	 * the wake pipeline. The pipeline flips the status when the lesson has
	 * actually resumed — until then the job reads "running" so the client's
	 * activity card keeps polling and re-syncs once, at the end.
	 */
	async function finishJob(jobId: string, result: JobResult): Promise<void> {
		const job = jobStore.getJob(jobId);
		if (!job || !stillRunning(jobId)) return;
		jobStore.updateJob(jobId, {
			result,
			activity: "delivering result",
			...(result.failure !== undefined ? { error: result.failure } : {}),
		});
		try {
			await deliver(job.chatId, buildSubagentSteer(job, result));
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			console.error(`[job ${jobId}] steer delivery failed:`, err);
			// An abort that landed during delivery stays the terminal fact.
			if (stillRunning(jobId)) jobStore.updateJob(jobId, { status: "error", error: reason, activity: "delivery failed" });
		}
	}

	return { runJob };
}
