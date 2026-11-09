/** The background-agents feed: one GET /api/activity, refetched on
 *  activity/jobs announcements (trailing 250ms), reconnect, and visibility. */
import type { JobKind } from "@/src/jobs/model";
import { formatElapsed, toBlobs, type ActivityBlob, type ActivityFeed, type FeedExtraction, type FeedJob } from "./activity";
export { formatElapsed, toBlobs } from "./activity";
import { serverEvents } from "./server-events";

const EMPTY: ActivityFeed = { jobs: [], extractions: [] };

class ActivityStore {
	feed = $state<ActivityFeed>(EMPTY);
	private initialized = false;
	private debounce: ReturnType<typeof setTimeout> | undefined;
	private offs: Array<() => void> = [];

	init(): void {
		if (this.initialized || typeof window === "undefined") return;
		this.initialized = true;
		this.refresh();
		const schedule = () => {
			clearTimeout(this.debounce);
			this.debounce = setTimeout(() => this.refresh(), 250);
		};
		this.offs.push(serverEvents.subscribe("activity-changed", schedule));
		this.offs.push(serverEvents.subscribe("jobs-changed", schedule));
		this.offs.push(serverEvents.onResync(() => this.refresh()));
		const onVisibility = () => {
			if (document.visibilityState === "visible") this.refresh();
		};
		document.addEventListener("visibilitychange", onVisibility);
		this.offs.push(() => document.removeEventListener("visibilitychange", onVisibility));
	}

	refresh = (): void => {
		void fetch("/api/activity")
			.then((r) => (r.ok ? (r.json() as Promise<Partial<ActivityFeed>>) : null))
			.then((data) => {
				if (data) this.feed = { jobs: data.jobs ?? [], extractions: data.extractions ?? [] };
			})
			.catch(() => {});
	};
}

export const activity = new ActivityStore();
