/**
 * POST /api/graph/import — the format-agnostic front door's transport
 * (vision §1, 2026-09-13): raw personal-notes files in, one extraction run
 * per file through the SAME pipeline the sessions use. Multipart form data
 * (field "files", any text format — the extractor is format-agnostic); the
 * pipeline mints a deterministic source id per file path, persists the
 * source record (the file's provenance + the run's usage), and runs
 * extractor → auditor → merger over the raw text.
 *
 * Files run as wide as the background LLM pool: a burst of simultaneous
 * runs would trip provider rate limits. The dock's chips + graph refetch track progress live through
 * /api/graph/status, as with session runs.
 */
import { services } from "@/src/boot";
import { BG_LLM_PERMITS } from "@/src/jobs";
import { NotesImportError } from "@/src/graph";
import { MODELS_NOT_CONFIGURED_CODE, ModelsNotConfiguredError, PROVIDER_KEY_MISSING_CODE, ProviderKeyMissingError } from "@/src/settings/model";
import type { NotesImportResult } from "@/src/graph/model";
import type { RequestEvent } from "./$types";

export async function POST({ request }: RequestEvent) {
	const form = await request.formData();
	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	if (files.length === 0) {
		return Response.json({ results: [] as NotesImportResult[], error: "no files" }, { status: 400 });
	}

	const results: NotesImportResult[] = [];
	const queue = files.map((file, requestIndex) => ({ file, requestIndex }));
	const workers = Array.from({ length: Math.min(BG_LLM_PERMITS, files.length) }, async () => {
		for (;;) {
			const next = queue.shift();
			if (!next) return;
			const { file, requestIndex } = next;
			try {
				const text = await file.text();
				const stats = await services().extraction.importNotes({ filePath: file.name, text });
				results.push({ filePath: file.name, requestIndex, outcome: "completed", ok: true, stats });
			} catch (err) {
				if (err instanceof ModelsNotConfiguredError) {
					results.push({
						filePath: file.name,
						ok: false,
						requestIndex, outcome: "failed",
						error: err.envelope.error,
						code: MODELS_NOT_CONFIGURED_CODE,
						missing: err.envelope.missing,
					});
					continue;
				}
				if (err instanceof ProviderKeyMissingError) {
					results.push({
						filePath: file.name,
						ok: false,
						requestIndex, outcome: "failed",
						error: err.envelope.error,
						code: PROVIDER_KEY_MISSING_CODE,
						provider: err.envelope.provider,
						slots: err.envelope.slots,
					});
					continue;
				}
				results.push({
					filePath: file.name, requestIndex, ok: false,
					outcome: err instanceof NotesImportError ? err.outcome : "failed",
					...(err instanceof NotesImportError ? { stats: err.partialStats } : {}),
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	});
	await Promise.all(workers);
	return Response.json({ results });
}