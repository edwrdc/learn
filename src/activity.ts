/**
 * The activity dock's feed: the bottom-right dock is visible in every view,
 * so it needs the complete running-process picture — sub-agent jobs across
 * ALL chats plus the global extraction runs — in one poll. The dock is
 * BACKGROUND PROCESSES ONLY (owner decision): teaching sessions have their
 * own observability, so in-flight teacher turns are deliberately NOT in the
 * feed. /api/jobs stays chat-scoped; the dock is a different consumer with a
 * different shape, served here.
 */

import { extractionRuns, graphRevision } from "./graph/index.ts";
import { stores } from "./stores.ts";
import { catalogContextLimits } from "./settings/index.ts";
import type { ActivityExtraction, ActivityFeed, ActivityJob } from "./jobs/model/index.ts";


/** The dock's whole world in one payload: every running process, every view.
 *  Jobs are RUNNING-ONLY — finished jobs belong to their chat's transcript;
 *  the blob disappears when the process ends. Cost math is NOT done here:
 *  raw usage rides on the records and the client folds it.
 *  graphRevision lets any view detect "the graph changed underneath me" (a
 *  merge landed, a deletion purged) and refetch; the node DELETE response
 *  returns the same stamp. */
export async function activityFeed(): Promise<ActivityFeed> {
	const chats = await stores.chatStore.listChats();
	const limits = catalogContextLimits();
	const jobs: ActivityJob[] = [];
	for (const chat of chats) {
		for (const job of stores.jobStore.listJobs(chat.id)) {
			if (job.status === "running") {
				jobs.push({
					...job,
					title: chat.title ?? chat.id,
					contextLimit: job.usage ? (limits.get(job.usage.model) ?? null) : null,
				});
			}
		}
	}
	const extractions: ActivityExtraction[] = (await extractionRuns()).map(({ usage: _usage, ...run }) => run);
	// oldest-first on last activity: the stable blob order
	jobs.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
	return {
		jobs,
		extractions,
		graphRevision: graphRevision(),
	};
}
