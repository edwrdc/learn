import { Type } from "typebox";
import type { AppTool } from "../tool-adapter.ts";
import { resolveSourcePath } from "../tools/fs-shared.ts";
import {
	backgroundRun,
	type PdfRunState,
	type RoleRunIdentity,
	type RoleStateIo,
	textResult,
} from "./durable-run.ts";
import type { PdfResult, PdfToolInput } from "../../core/contracts.ts";
import { getHeadless, type HeadlessApi, type RenderedPdfPage } from "./headless.ts";
import { pdfExtract, pdfInfo, pdfProbe, pdfSearch } from "./pdf-ops.ts";
import type { PiEngine } from "../models.ts";

/**
 * The pdf-reader sub-agent (sources v0, 2026-09): reads a learner-provided
 * PDF on the teacher's behalf. The loop is a durable conversation
 * (durable-run.ts): consulted/read page sets and the pending render live in
 * the run descriptor, the rendered pages ride a user message appended AFTER
 * the round's tool results (image-in-the-loop, user-decided), and the
 * one-nudge "you read nothing" doctrine gate is the run's onYield hook.
 *
 * System prompt = the pdf-reader skill's reading doctrine, verbatim in
 * strategy: triage with pdf_info FIRST, then size-based strategy — short
 * PDFs render all pages, medium render flagged (math/image-heavy) pages,
 * long ones search for targeted lookups before reading anything at length.
 *
 * Its final text IS the brief (researcher idiom), with (p. N) citations;
 * runPdfJob wraps it into PdfResult with pagesConsulted tracked by the loop.
 */

const INSTRUCTIONS = `You are a PDF reading specialist. You work for a teacher agent inside a learning
application: given a PDF path and a question, read the document on the teacher's behalf and
produce a focused brief that the teacher can teach from, with page citations.

You operate in an isolated context. The task gives you the PDF path and the question — that is
everything you know.

Reading doctrine — always in this order:
1. TRIAGE FIRST: call pdf_info. It returns page count plus per-page signals (text_length,
   image_count, math_density). Never read or render anything before this.
2. Pick a strategy by document size:
   - SHORT (≤ 10 pages): extract the full text; render every page that has meaningful
     math_density or images (you read equations and diagrams visually, not as extracted text).
   - MEDIUM (11-40 pages): extract promising pages; render only flagged pages (math- or
     image-heavy, or where extraction looks thin).
   - LONG (> 40 pages): pdf_search for the question's key terms first; extract and render only
     the pages that hit. Never read a long document front-to-back.
3. When the extracted text of a page looks math- or diagram-heavy, or garbled, RENDER that
   page and read it visually before drawing conclusions from it.
4. Render DPI guidance: 100 for text-dominant pages, 150 the default, 200 for dense small
   print (math details, fine diagrams).

Tool outputs may be error strings (file unreadable, invalid regex, no hits). Adapt: narrow the
page spec, change the query, lower DPI. If the document genuinely cannot answer the question,
say so in the brief instead of inventing content.

Your FINAL assistant message is your entire deliverable — it must stand alone, in this format:
2-6 sentences (or short sections) answering the teacher's question from the document, each
claim cited as (p. N). End with a line "Pages consulted: N, N, …" listing every page you
extracted or rendered.`;

const MAX_ITERATIONS = 14;
/** Rendered pages per pdf_render call — the skill renders selectively; a
 *  batch cap keeps one over-eager call from flooding the vision context. */
const RENDER_BATCH_CAP = 6;
/** Extract output ceiling — narrow the spec instead of dumping a book. */
const EXTRACT_CAP = 24_000;

export interface PdfReaderOptions {
	engine?: PiEngine;
	abortSignal?: AbortSignal;
	onUsage?: (usage: import("../../core/contracts.ts").JobUsage) => void;
	onActivity?: (line: string) => void;
	headless?: HeadlessApi;
	maxIterations?: number;
	/** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
	chatId?: string;
	/** The durable owner + stable run key (the job id in production). */
	run: RoleRunIdentity;
}

export interface PdfReaderInput extends PdfToolInput {}

function addPages(state: PdfRunState, pages: readonly number[], read: boolean): void {
	for (const page of pages) {
		if (!state.consulted.includes(page)) state.consulted.push(page);
		if (read && !state.read.includes(page)) state.read.push(page);
	}
}

/** pdf_info's body (the tool's dispatch target): the triage readout. */
async function pdfInfoText(pdfPath: string): Promise<string> {
	const info = await pdfInfo(pdfPath);
	const lines = [
		`File: ${info.path}`,
		`Pages: ${info.page_count} (mean text length/page: ${info.mean_text_length})`,
		...info.pages.map(
			(p) =>
				`p${p.page}: len=${p.text_length} img=${p.image_count} math=${p.math_density.toFixed(2)}`,
		),
	];
	return lines.join("\n");
}

/** pdf_extract's body: capped text extraction with the narrow-the-spec notice. */
async function pdfExtractText(pdfPath: string, pages: string): Promise<string> {
	const text = await pdfExtract(pdfPath, pages);
	if (text.length > EXTRACT_CAP) {
		return `${text.slice(0, EXTRACT_CAP)}\n\n[Output truncated at ${EXTRACT_CAP} chars — narrow the page spec and extract in smaller batches.]`;
	}
	return text;
}

/** The role's tool registrations, rebuilt from the persisted descriptor on a
 *  later process. */
export function pdfRoleTools(
	io: RoleStateIo<PdfRunState>,
	pdfPath: string,
	headless: HeadlessApi,
	onActivity?: (line: string) => void,
): Record<string, AppTool<any>> {
	return {
		pdf_info: {
			name: "pdf_info",
			description: "Metadata + per-page triage signals for the PDF (page count, text length, image count, math density). ALWAYS call this first.",
			parameters: Type.Object({}),
			executionMode: "sequential",
			async execute() {
				onActivity?.("pdf_info: triaging");
				return textResult(await pdfInfoText(pdfPath));
			},
		},
		pdf_extract: {
			name: "pdf_extract",
			description: "Extract text from pages (spec: 'all', '1-5', '1,3,7', '3'). Use pdf_info first; narrow the spec for big documents.",
			parameters: Type.Object({
				pages: Type.String({ description: "Page spec, e.g. 'all', '1-5', '1,3,7'" }),
			}),
			executionMode: "sequential",
			async execute(_toolCallId, raw) {
				const spec = (raw as { pages: string }).pages;
				onActivity?.(`pdf_extract: ${spec}`);
				const body = await pdfExtractText(pdfPath, spec);
				const numbers = specNumbers(spec, Infinity);
				await io.update((state) => addPages(state, numbers, true));
				return textResult(body);
			},
		},
		pdf_render: {
			name: "pdf_render",
			description:
				"Render pages to images and show them to you for visual reading (equations, diagrams, layout). DPI: 100 text, 150 default, 200 dense small print. Max 6 pages per call.",
			parameters: Type.Object({
				pages: Type.String({ description: "Page spec, e.g. '1-3' or '2,5,8'" }),
				dpi: Type.Optional(
					Type.Integer({ minimum: 72, maximum: 300, description: "Render DPI (100 text / 150 default / 200 dense)" }),
				),
			}),
			executionMode: "sequential",
			async execute(_toolCallId, raw) {
				const { pages: spec, dpi } = raw as { pages: string; dpi?: number };
				const wanted = specNumbers(spec, RENDER_BATCH_CAP);
				const resolution = numOr(dpi, 150);
				onActivity?.(`pdf_render: ${spec} @${resolution}dpi`);
				const reason = headless.unavailableReason();
				if (reason) return textResult(`ERROR: ${reason}`);
				if (wanted.length === 0) return textResult("ERROR: no pages rendered (spec matched nothing?)");
				// The actual render happens in the durable after-tools hook (one
				// render per call): it commits the pages as read and appends the
				// images AFTER this tool's result, exactly the old message order.
				await io.update((state) => {
					state.pendingRender = { pages: wanted, dpi: resolution };
				});
				return textResult(
					`Rendered ${wanted.length} page(s) at ${resolution} DPI — the images follow below. Read them carefully (equations, diagrams, layout).`,
				);
			},
		},
		pdf_search: {
			name: "pdf_search",
			description: "Search the PDF's text by keyword or regex (case-insensitive); returns hits with context lines. Use for long documents before reading anything at length.",
			parameters: Type.Object({
				query: Type.String({ description: "Keyword or regex" }),
				context_lines: Type.Optional(
					Type.Integer({ minimum: 0, maximum: 8, description: "Context lines around each hit (default 3)" }),
				),
				literal: Type.Optional(Type.Boolean({ description: "true = treat the query literally (no regex; default false)" })),
			}),
			executionMode: "sequential",
			async execute(_toolCallId, raw) {
				const { query, context_lines, literal } = raw as { query: string; context_lines?: number; literal?: boolean };
				const contextLines = numOr(context_lines, 3);
				onActivity?.(`pdf_search: "${query}"`);
				const { hits } = await pdfSearch(pdfPath, query, { contextLines, literal: Boolean(literal) });
				const pages = [...new Set(hits.map((h) => h.page))];
				await io.update((state) => addPages(state, pages, false));
				const cap = hits.slice(0, 40);
				const body =
					cap.length === 0
						? "No hits."
						: cap.map((h) => `=== Page ${h.page}, line ${h.line} ===\n${h.context}`).join("\n") +
							(hits.length > cap.length ? `\n\n[${hits.length - cap.length} more hits — narrow the query.]` : "");
				return textResult(body);
			},
		},
	};
}

/** The doctrine gate's continuation text (the visual-maker's unlooked-finish
 *  rule, ported): never deliver a brief that consulted nothing. */
export const PDF_UNREAD_MESSAGE =
	"You finished without consulting any page of the PDF — your brief would be invention, not reading. Extract or render the relevant pages first, then write the brief from what you actually saw.";

/** The image-in-the-loop user message content: appended after the tool
 *  results, in render order. */
export function pdfImageContent(pages: readonly RenderedPdfPage[]): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
	return [
		{
			type: "text",
			text: `The rendered page(s), in order (${pages.map((p) => `p${p.page}`).join(", ")}):`,
		},
		...pages.map((p) => ({ type: "image" as const, data: p.png.toString("base64"), mimeType: "image/png" })),
	];
}

export async function runPdfReaderAgent(input: PdfReaderInput, opts: PdfReaderOptions): Promise<PdfResult> {
	const headless = opts.headless ?? getHeadless();
	const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
	const pdfPath = resolveSourcePath(input.path);
	const empty = { pagesRead: [] as number[], pagesConsulted: [] as number[] };

	// Deterministic upfront failure: unreadable / unparseable
	// for renders — the brief never starts on a broken source.
	const openError = await probeReadable(pdfPath);
	if (openError) {
		return { path: pdfPath, question: input.question, brief: `PDF failed: ${openError}`, ...empty };
	}
	// No Chrome gate (Wave E, 2026-10-10): pdf_render is native now
	// (pdfjs paints into @napi-rs/canvas in-process) — the whole pdf-reader
	// runs browser-free; text tools always worked without one.
	if (!opts.run) throw new Error("pdf reader: a durable run identity is required (chatId + jobId)");
	if (!opts.engine) throw new Error("pdf reader: no model engine was resolved");

	const prompt = [
		`PDF path: ${pdfPath}`,
		`Question (what the teacher needs from this document): ${input.question || "(no question — give a structural overview)"}`,
		"",
		"Read the document per your doctrine, then produce your final brief in the required format.",
	].join("\n");

	let outcome;
	try {
		outcome = await backgroundRun({
			jobId: opts.run.jobId,
			chatId: opts.run.chatId,
			kind: "pdf",
			role: "pdfReader",
			engine: opts.engine,
			maxTurns: maxIterations,
			systemPrompt: INSTRUCTIONS,
			prompt,
			input: { path: pdfPath, question: input.question },
			headless,
			signal: opts.abortSignal,
			onActivity: opts.onActivity,
			onUsage: opts.onUsage,
		});
	} catch (err) {
		// A caller abort keeps the old loop's failure shape; an AbortError
		// WITHOUT a caller abort is a runtime close: rethrow (recoverable).
		if (!opts.abortSignal?.aborted && err instanceof Error && err.name === "AbortError") throw err;
		const msg = err instanceof Error ? err.message : String(err);
		const state = (err as { runState?: PdfRunState }).runState;
		return {
			path: pdfPath,
			question: input.question,
			brief: `PDF failed: the reader crashed — ${msg}`,
			pagesRead: state?.read ?? [],
			pagesConsulted: state?.consulted ?? [],
		};
	}

	const state = outcome.state as PdfRunState;
	const pagesRead = [...state.read].sort((a, b) => a - b);
	const pagesConsulted = [...state.consulted].sort((a, b) => a - b);
	const text = outcome.text;
	if (state.blockedAtCap || (outcome.capped && !text.trim())) {
		return {
			path: pdfPath,
			question: input.question,
			brief: `PDF failed: iteration limit (${maxIterations}) reached without a brief.`,
			pagesRead,
			pagesConsulted,
		};
	}
	return {
		path: pdfPath,
		question: input.question,
		brief: text.trim() || "(no brief text)",
		pagesRead,
		pagesConsulted,
	};
}

// ─── small helpers ───────────────────────────────────────────────────────────

/** Parse a page spec into concrete page numbers, capped. */
export function specNumbers(spec: string, cap: number): number[] {
	// total = Infinity: bounds come from the document at execution time; the
	// cap alone protects the batch.
	const parts = spec.trim().toLowerCase() === "all" ? [`${cap}`] : spec.split(",");
	const out = new Set<number>();
	for (const part of parts) {
		const p = part.trim();
		if (!p) continue;
		if (p.includes("-")) {
			const [s, e] = p.split("-", 2) as [string, string];
			const start = Math.max(1, parseInt(s, 10) || 1);
			const end = Math.min(parseInt(e, 10) || start, start + cap - 1);
			for (let pg = start; pg <= end && out.size < cap; pg++) out.add(pg);
		} else {
			const pg = parseInt(p, 10);
			if (Number.isFinite(pg) && pg >= 1 && out.size < cap) out.add(pg);
		}
	}
	return [...out].sort((a, b) => a - b);
}

function numOr(v: unknown, dflt: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

/** Cheap upfront readability probe — real parsing happens inside the tools. */
async function probeReadable(pdfPath: string): Promise<string | null> {
	try {
		const fs = await import("node:fs/promises");
		const stat = await fs.stat(pdfPath);
		if (!stat.isFile()) return "not a regular file";
		if (stat.size === 0) return "file is empty";
		// parse probe: pdfProbe throws pdfjs's precise error for garbage files
		await pdfProbe(pdfPath);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}
