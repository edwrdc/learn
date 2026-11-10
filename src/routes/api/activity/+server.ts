/**
 * GET /api/activity — the dock's one poll: every running background
 * process, every view. Cost folds client-side.
 */
import { activityFeed } from "@/src/activity";

export async function GET() {
	return Response.json(await activityFeed());
}
