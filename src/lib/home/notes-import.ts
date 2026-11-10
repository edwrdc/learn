import type { NotesImportResult } from "@/src/graph/model";
import { importNotes } from "$lib/api/graph";
import { ApiError } from "$lib/api/http";

/** Notes import transport: response validation and error projection. */
export function parseNotesImportResults(body: unknown, files: readonly File[]): NotesImportResult[] {
	const invalid = () => new Error("Invalid import response. Please retry the file.");
	if (!body || typeof body !== "object" || !("results" in body) || !Array.isArray(body.results) || body.results.length !== files.length) throw invalid();
	const seen = new Set<number>();
	for (const raw of body.results) {
		if (!raw || typeof raw !== "object") throw invalid();
		const result = raw as NotesImportResult;
		if (
			!Number.isInteger(result.requestIndex) ||
			result.requestIndex < 0 ||
			result.requestIndex >= files.length ||
			seen.has(result.requestIndex) ||
			result.filePath !== files[result.requestIndex]!.name
		)
			throw invalid();
		seen.add(result.requestIndex);
		if (!["completed", "failed", "partial", "aborted", "busy"].includes(result.outcome) || typeof result.ok !== "boolean" || result.ok !== (result.outcome === "completed")) throw invalid();
		if (
			result.stats !== undefined &&
			(!result.stats ||
				typeof result.stats !== "object" ||
				!Number.isFinite(result.stats.nodes) ||
				result.stats.nodes < 0 ||
				!Number.isFinite(result.stats.chains) ||
				result.stats.chains < 0)
		)
			throw invalid();
		if (result.ok && !result.stats) throw invalid();
		if (!result.ok && typeof result.error !== "string") throw invalid();
		for (const field of ["error", "code", "provider"] as const) if (result[field] !== undefined && typeof result[field] !== "string") throw invalid();
		for (const field of ["missing", "slots"] as const)
			if (result[field] !== undefined && (!Array.isArray(result[field]) || !result[field]!.every((value) => typeof value === "string"))) throw invalid();
	}
	return body.results as NotesImportResult[];
}

export async function postNotesImport(files: readonly File[]): Promise<NotesImportResult[]> {
	let body: unknown;
	try {
		body = await importNotes(files);
	} catch (error) {
		if (!(error instanceof ApiError)) throw error;
		const detail = error.body?.error ? `: ${error.body.error}` : "";
		throw new Error(`Import request failed (HTTP ${error.status})${detail}. Please retry the file.`);
	}
	return parseNotesImportResults(body, files);
}

export function notesImportErrors(results: readonly NotesImportResult[]): string[] {
	return results
		.filter((result) => !result.ok)
		.sort((a, b) => a.requestIndex - b.requestIndex)
		.map(
			(result) =>
				`${result.filePath}: ${result.error}${result.code ? `\n${result.code}${result.provider ? ` — ${result.provider}` : ""}${result.missing?.length ? ` — ${result.missing.join(", ")}` : ""}${result.slots?.length ? ` — ${result.slots.join(", ")}` : ""}` : ""}`,
		);
}
