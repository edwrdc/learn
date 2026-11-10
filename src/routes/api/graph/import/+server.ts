/**
 * POST /api/graph/import — raw personal-notes files in, one extraction run
 * per file through the SAME pipeline the sessions use. Multipart form data
 * (field "files", any text format — the extractor is format-agnostic); the
 * pipeline mints a deterministic source id per file path, persists the
 * source record (the file's provenance + the run's usage), and runs
 * extractor → auditor → merger over the raw text.
 *
 * Files run as wide as the background LLM pool: a burst of simultaneous
 * runs would trip provider rate limits. The dock tracks progress live.
 */
import { services } from "@/src/boot";
import { NotesImportError } from "@/src/graph";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "@/src/settings/model";
import type { NotesImportResult } from "@/src/graph/model";
import type { RequestEvent } from "./$types";

export async function POST({ request }: RequestEvent) {
	const form = await request.formData();
	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	if (files.length === 0) {
		return Response.json({ results: [] as NotesImportResult[], error: "no files" }, { status: 400 });
	}

	const outcomes = await services().extraction.importNotesFiles(files.map((file) => ({ filePath: file.name, text: () => file.text() })));
	const results = outcomes.map((outcome, requestIndex): NotesImportResult => {
		const filePath = files[requestIndex]!.name;
		if (outcome.status === "fulfilled") return { filePath, requestIndex, outcome: "completed", ok: true, stats: outcome.value };
		const err = outcome.reason;
		if (err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) {
			return { filePath, requestIndex, ok: false, outcome: "failed", ...err.envelope };
		}
		return {
			filePath, requestIndex, ok: false,
			outcome: err instanceof NotesImportError ? err.outcome : "failed",
			...(err instanceof NotesImportError ? { stats: err.partialStats } : {}),
			error: err instanceof Error ? err.message : String(err),
		};
	});
	return Response.json({ results });
}