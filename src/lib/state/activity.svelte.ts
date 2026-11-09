/** The background-agents feed (GET /api/activity). */
import { fetchActivity } from "$lib/api/activity";
import { Resource } from "./resource.svelte";
export { formatElapsed, toBlobs } from "./activity";

export const activity = new Resource("activity", fetchActivity, { events: ["activity-changed", "jobs-changed"], visibility: true });
