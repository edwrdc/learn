import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import type { AppTool } from "../adapter.ts";
import { serverExecute, type ImageFileResult } from "../execute.ts";
import { formatSize, MAX_OUTPUT_BYTES, resolveSourcePath } from "./shared.ts";

/**
 * The read tool: a Node port of pi's read for the learner's local files.
 * Unrestricted local reads are an owner decision — this is a personal study
 * harness, not a multi-tenant service.
 *
 * - text files: offset (1-indexed) / limit slicing, and the 2000-line /
 *   50KB ceiling with "use offset=N" continuation notices.
 * - image files: returned as native image content parts.
 * - unreadable/missing files throw — pi turns that into an error tool
 *   result the model sees.
 */

const MAX_LINES = 2000;

/** pi sniffs magic bytes; extensions suffice here — learner files are
 *  pasted paths, not adversarial uploads. */
const IMAGE_MIME: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

const readInput = Type.Object({
	path: Type.String({ minLength: 1, description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
});

function readTextSlice(text: string, offset: number | undefined, limit: number | undefined): string {
	const allLines = text.split("\n");
	const totalLines = allLines.length;
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	if (startLine >= totalLines) {
		throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
	}
	let selected = allLines.slice(startLine, limit !== undefined ? startLine + limit : totalLines);
	let truncatedBy: "lines" | "bytes" | null = null;
	if (selected.length > MAX_LINES) {
		selected = selected.slice(0, MAX_LINES);
		truncatedBy = "lines";
	}
	if (Buffer.byteLength(selected.join("\n"), "utf-8") > MAX_OUTPUT_BYTES) {
		while (selected.length > 0 && Buffer.byteLength(selected.join("\n"), "utf-8") > MAX_OUTPUT_BYTES) {
			selected.pop();
		}
		truncatedBy = "bytes";
	}
	if (truncatedBy === null) {
		const remaining = totalLines - (startLine + selected.length);
		if (remaining > 0) {
			return `${selected.join("\n")}\n\n[${remaining} more lines in file. Use offset=${startLine + selected.length + 1} to continue.]`;
		}
		return selected.join("\n");
	}
	const endLineDisplay = startLine + selected.length;
	const reason =
		truncatedBy === "lines" ? `${MAX_LINES} line limit` : `${formatSize(MAX_OUTPUT_BYTES)} limit`;
	return `${selected.join("\n")}\n\n[Showing lines ${startLine + 1}-${endLineDisplay} of ${totalLines} (${reason}). Use offset=${endLineDisplay + 1} to continue.]`;
}

/** Shared by the prober and the teacher. The description is pi-verbatim
 *  (owner decision); the teaching doctrine lives in prompts/shared/. */
export const readTool: AppTool<typeof readInput> = {
	name: "read",
	description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50.0KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
	parameters: readInput,
	execute: serverExecute("read", readInput, async ({ path: rawPath, offset, limit }): Promise<string | ImageFileResult> => {
		const absolute = resolveSourcePath(rawPath);
		const ext = path.extname(absolute).toLowerCase();
		const mime = IMAGE_MIME[ext];
		const buffer = await fs.readFile(absolute);
		if (mime) {
			// No resize: raw bytes as base64.
			return {
				text: `Read image file [${mime}] — ${path.basename(absolute)} (${formatSize(buffer.byteLength)}), attached as an image.`,
				images: [{ data: buffer.toString("base64"), mimeType: mime }],
			};
		}
		const text = buffer.toString("utf-8");
		return readTextSlice(text, offset, limit);
	}),
};
