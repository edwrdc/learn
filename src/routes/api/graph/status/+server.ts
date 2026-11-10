/**
 * GET /api/graph/status — the in-flight background extraction runs
 * (vision §1: the pipeline status must be visible on the home graph).
 * Thin transport over the pipeline's module-level registry: phase
 * (queued / extracting / waiting / auditing / merging) per job, oldest
 * first — a multi-chunk source shows one row PER CHUNK ("· i/N" suffix,
 * per-chunk jobs, owner 2026-09-28). A missing chat record still
 * reports the run.
 */
import { extractionRuns } from "@/src/graph";

export async function GET() {
	return Response.json({ runs: await extractionRuns() });
}
