/**
 * POST /api/activity/abort — the dock's END/ABORT control, uniform across
 * process kinds: body {kind: "job"|"extraction"|"turn", id} where id is the
 * jobId for sub-agent jobs and the chatId for extraction runs (the pipeline
 * registry is chat-keyed) and turns (a running turn is a background object —
 * any client may stop it here; a view leaving NEVER kills it).
 *
 * Outcomes: a job's not_found -> 404, not_running -> 409, aborted -> 200.
 * A turn mirrors the job semantics: not_running -> 409 (honest "nothing to
 * abort" — the caller refetches), aborted -> 200 (partial persists via
 * the usual settle path, every subscriber closes cleanly).
 * Extraction abort is idempotent by design (aborting with nothing in
 * flight is success — the blob is gone either way) -> 200.
 */
import { abortExtraction } from "@/src/graph";
import { abortJob } from "@/src/jobs";
import { abortTurn } from "@/src/session";
import { readJson } from "@/src/platform";
import { isSafeId } from "@/src/platform/model";
import type { RequestEvent } from "./$types";

export async function POST({ request: req }: RequestEvent) {
	const json = await readJson(req);
	if (json instanceof Response) return json;
	const { kind, id } = (json.body ?? {}) as { kind?: string; id?: string };
	if ((kind !== "job" && kind !== "extraction" && kind !== "turn") || typeof id !== "string" || id === "") {
		return Response.json({ error: 'Body must be {kind: "job"|"extraction"|"turn", id: string}' }, { status: 400 });
	}
	if (!isSafeId(id)) {
		return Response.json({ error: "Invalid id" }, { status: 400 });
	}

	if (kind === "job") {
		const outcome = abortJob(id);
		if (!outcome.ok) {
			return outcome.reason === "not_found"
				? Response.json({ error: "Unknown job", code: outcome.reason }, { status: 404 })
				: Response.json({ error: "The job is not running", code: outcome.reason }, { status: 409 });
		}
		return Response.json({ ok: true });
	}
	if (kind === "turn") {
		const outcome = abortTurn(id);
		if (!outcome.ok) return Response.json({ error: "No turn is running", code: outcome.reason }, { status: 409 });
		return Response.json({ ok: true });
	}
	abortExtraction(id);
	return Response.json({ ok: true });
}
