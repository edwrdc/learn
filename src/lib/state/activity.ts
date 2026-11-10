/** The background-agents feed's pure fold: jobs + extractions → ordered
 *  blobs, money/context doctrine included. */
import { jobCost } from "@/src/session/model";
import type { ActivityFeed, JobKind } from "@/src/jobs/model";
import { MODELS_NOT_CONFIGURED_CODE, PROVIDER_KEY_MISSING_CODE, type RefusalCode } from "@/src/settings/model";

/** How a refused job reads: its status line and the fix button's label. */
export const REFUSAL_COPY: Record<RefusalCode, { status: string; action: string }> = {
	[MODELS_NOT_CONFIGURED_CODE]: { status: "needs model setup", action: "Set up models" },
	[PROVIDER_KEY_MISSING_CODE]: { status: "needs a provider key", action: "Add a key" },
};

export interface ActivityBlob {
	id: string;
	process: "job" | "extraction";
	jobKind?: JobKind;
	phase?: string;
	title: string;
	chatId: string;
	startedAt: number;
	cost: number | null;
	context: { used: number; limit: number } | null;
	activity: string;
	model?: string;
	steps?: number;
}

export function toBlobs(feed: Pick<ActivityFeed, "jobs" | "extractions"> | undefined): ActivityBlob[] {
	if (!feed) return [];
	const blobs: ActivityBlob[] = feed.jobs.map((job) => {
		const usage = job.usage;
		let context: ActivityBlob["context"] = null;
		const lastStep = usage?.lastStep;
		const limit = job.contextLimit;
		if (usage && lastStep && limit !== null && lastStep.inputTokens !== undefined) {
			context = {
				used:
					lastStep.inputTokens +
					(lastStep.outputTokens ?? 0) +
					(lastStep.cacheReadTokens ?? 0) +
					(lastStep.cacheWriteTokens ?? 0),
				limit,
			};
		}
		return {
			id: job.id,
			process: "job",
			jobKind: job.kind,
			title: job.title,
			chatId: job.chatId,
			startedAt: Date.parse(job.createdAt) || 0,
			cost: jobCost(job),
			context,
			activity: job.refusal ? REFUSAL_COPY[job.refusal].status : (job.activity ?? ""),
			model: usage?.model,
			steps: usage?.steps,
		};
	});
	for (const run of feed.extractions) {
		blobs.push({
			id: run.id,
			process: "extraction",
			phase: run.phase,
			title: run.title,
			chatId: run.chatId,
			startedAt: run.startedAt,
			cost: null,
			context: null,
			activity: "",
		});
	}
	blobs.sort((a, b) => a.startedAt - b.startedAt);
	return blobs;
}

export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
