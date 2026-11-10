/**
 * GET /api/graph/status — the in-flight background extraction runs: phase
 * (queued / extracting / waiting / auditing / merging) per job, oldest
 * first — a multi-chunk source shows one row PER CHUNK ("· i/N" suffix). A
 * missing chat record still reports the run.
 */
import { extractionRuns } from "@/src/graph";

export async function GET() {
	return Response.json({ runs: await extractionRuns() });
}
