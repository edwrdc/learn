import { Type } from "typebox";
import * as fs from "node:fs/promises";
import { parsePageSpec, pdfExtract, pdfInfo, pdfPageCount, pdfProbe, pdfSearch, resolveSourcePath, serverExecute } from "../../tools/index.ts";
import type { PdfRunState } from "../durable-run.ts";
import type { PdfResult } from "../model/types.ts";
import type { PdfInput } from "../tools.ts";
import type { RenderedPdfPage } from "../headless.ts";
import type { JobRole } from "./role.ts";

/**
 * The pdf-reader sub-agent: reads a learner-provided PDF on the teacher's
 * behalf. Consulted/read page sets and the pending render live in the run
 * state; `afterTools` shows rendered pages after the round's tool results
 * (image-in-the-loop, owner decision), and `onYield` is
 * the one-nudge "you read nothing" doctrine gate.
 *
 * System prompt = the pdf-reader skill's reading doctrine, verbatim in
 * strategy: triage with pdf_info FIRST, then size-based strategy — short
 * PDFs render all pages, medium render flagged (math/image-heavy) pages,
 * long ones search for targeted lookups before reading anything at length.
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

/** Rendered pages per pdf_render call — the skill renders selectively; a
 *  batch cap keeps one over-eager call from flooding the vision context. */
const RENDER_BATCH_CAP = 6;
/** Extract output ceiling — narrow the spec instead of dumping a book. */
const EXTRACT_CAP = 24_000;

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

/** The doctrine gate's continuation text (the visual-maker's unlooked-finish
 *  rule, ported): never deliver a brief that consulted nothing. */
const PDF_UNREAD_MESSAGE =
	"You finished without consulting any page of the PDF — your brief would be invention, not reading. Extract or render the relevant pages first, then write the brief from what you actually saw.";

/** The image-in-the-loop user message content: appended after the tool
 *  results, in render order. */
function pdfImageContent(pages: readonly RenderedPdfPage[]): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
	return [
		{
			type: "text",
			text: `The rendered page(s), in order (${pages.map((p) => `p${p.page}`).join(", ")}):`,
		},
		...pages.map((p) => ({ type: "image" as const, data: p.png.toString("base64"), mimeType: "image/png" })),
	];
}

const pdfInfoInput = Type.Object({});
const pdfExtractInput = Type.Object({
	pages: Type.String({ description: "Page spec, e.g. 'all', '1-5', '1,3,7'" }),
});
const pdfRenderInput = Type.Object({
	pages: Type.String({ description: "Page spec, e.g. '1-3' or '2,5,8'" }),
	dpi: Type.Optional(Type.Integer({ minimum: 72, maximum: 300, description: "Render DPI (100 text / 150 default / 200 dense)" })),
});
const pdfSearchInput = Type.Object({
	query: Type.String({ description: "Keyword or regex" }),
	context_lines: Type.Optional(
		Type.Integer({ minimum: 0, maximum: 8, description: "Context lines around each hit (default 3)" }),
	),
	literal: Type.Optional(Type.Boolean({ description: "true = treat the query literally (no regex; default false)" })),
});

/** Cheap upfront readability probe — real parsing happens inside the tools. */
async function probeReadable(pdfPath: string): Promise<string | null> {
	try {
		const stat = await fs.stat(pdfPath);
		if (!stat.isFile()) return "not a regular file";
		if (stat.size === 0) return "file is empty";
		await pdfProbe(pdfPath);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

export const PDF_ROLE: JobRole<PdfInput, PdfResult, PdfRunState> = {
	kind: "pdf",
	model: "pdfReader",
	maxTurns: 14,
	instructions: INSTRUCTIONS,
	activity: "reading pdf",
	crashed: "the reader crashed",
	initialState: () => ({ kind: "pdf", consulted: [], read: [], pendingRender: null }),
	tools({ state, host, input }) {
		const pdfPath = String(input.path ?? "");
		return {
			pdf_info: {
				name: "pdf_info",
				description:
					"Metadata + per-page triage signals for the PDF (page count, text length, image count, math density). ALWAYS call this first.",
				parameters: pdfInfoInput,
				executionMode: "sequential",
				execute: serverExecute("pdf_info", pdfInfoInput, async () => {
					host.onActivity?.("pdf_info: triaging");
					return pdfInfoText(pdfPath);
				}),
			},
			pdf_extract: {
				name: "pdf_extract",
				description: "Extract text from pages (spec: 'all', '1-5', '1,3,7', '3'). Use pdf_info first; narrow the spec for big documents.",
				parameters: pdfExtractInput,
				executionMode: "sequential",
				execute: serverExecute("pdf_extract", pdfExtractInput, async ({ pages: spec }) => {
					host.onActivity?.(`pdf_extract: ${spec}`);
					const body = await pdfExtractText(pdfPath, spec);
					const pages = parsePageSpec(spec, await pdfPageCount(pdfPath));
					await state.update((next) => addPages(next, pages, true));
					return body;
				}),
			},
			pdf_render: {
				name: "pdf_render",
				description:
					"Render pages to images and show them to you for visual reading (equations, diagrams, layout). DPI: 100 text, 150 default, 200 dense small print. Max 6 pages per call.",
				parameters: pdfRenderInput,
				executionMode: "sequential",
				execute: serverExecute("pdf_render", pdfRenderInput, async ({ pages: spec, dpi }) => {
					const resolution = dpi ?? 150;
					host.onActivity?.(`pdf_render: ${spec} @${resolution}dpi`);
					const wanted = parsePageSpec(spec, await pdfPageCount(pdfPath)).slice(0, RENDER_BATCH_CAP);
					if (wanted.length === 0) return "ERROR: no pages rendered (spec matched nothing?)";
					await state.update((next) => {
						next.pendingRender = { pages: wanted, dpi: resolution };
					});
					return `Rendered ${wanted.length} page(s) at ${resolution} DPI — the images follow below. Read them carefully (equations, diagrams, layout).`;
				}),
			},
			pdf_search: {
				name: "pdf_search",
				description:
					"Search the PDF's text by keyword or regex (case-insensitive); returns hits with context lines. Use for long documents before reading anything at length.",
				parameters: pdfSearchInput,
				executionMode: "sequential",
				execute: serverExecute("pdf_search", pdfSearchInput, async ({ query, context_lines, literal }) => {
					host.onActivity?.(`pdf_search: "${query}"`);
					const { hits } = await pdfSearch(pdfPath, query, { contextLines: context_lines ?? 3, literal: Boolean(literal) });
					const pages = [...new Set(hits.map((h) => h.page))];
					await state.update((next) => addPages(next, pages, false));
					const cap = hits.slice(0, 40);
					return cap.length === 0
						? "No hits."
						: cap.map((h) => `=== Page ${h.page}, line ${h.line} ===\n${h.context}`).join("\n") +
								(hits.length > cap.length ? `\n\n[${hits.length - cap.length} more hits — narrow the query.]` : "");
				}),
			},
		};
	},
	/** The pending render, shown after the round's tool results. */
	async afterTools({ state, host, input }) {
		const { pendingRender } = await state.read();
		if (!pendingRender) return;
		const { pages, dpi } = pendingRender;
		let rendered: RenderedPdfPage[];
		try {
			rendered = await host.headless.renderPdfPages(String(input.path ?? ""), pages, { dpi });
			if (rendered.length === 0) throw new Error("no pages rendered (spec matched nothing?)");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await state.update(
				(next) => {
					next.pendingRender = null;
				},
				`RENDER ERROR (the page spec may be wrong): ${msg}. Narrow the spec and render again.`,
			);
			return;
		}
		await state.update(
			(next) => {
				next.pendingRender = null;
				addPages(
					next,
					rendered.map((page) => page.page),
					true,
				);
			},
			pdfImageContent(rendered),
		);
	},
	/** One nudge when the reader answers without consulting any page. */
	async onYield(run) {
		if ((await run.state.read()).consulted.length > 0) return undefined;
		if (await run.hasUserMessage(PDF_UNREAD_MESSAGE)) return undefined;
		if ((await run.turnsTaken()) + 1 >= run.maxTurns) {
			await run.markCapped();
			await run.state.update((next) => {
				next.blockedAtCap = true;
			});
			return undefined;
		}
		return PDF_UNREAD_MESSAGE;
	},
	input: (raw) => ({
		path: resolveSourcePath(typeof raw?.path === "string" ? raw.path.trim() : ""),
		question: typeof raw?.question === "string" ? raw.question : "",
	}),
	precheck: async (input) => probeReadable(input.path),
	prompt: ({ path, question }) =>
		[
			`PDF path: ${path}`,
			`Question (what the teacher needs from this document): ${question || "(no question — give a structural overview)"}`,
			"",
			"Read the document per your doctrine, then produce your final brief in the required format.",
		].join("\n"),
	async finish(input, { text, state, capped, maxTurns }) {
		if (state.blockedAtCap || (capped && !text.trim())) {
			return PDF_ROLE.failure(input, `iteration limit (${maxTurns}) reached without a brief.`, state);
		}
		return { ...input, brief: text.trim() || "(no brief text)", ...pageSets(state) };
	},
	failure: (input, reason, state) => ({ ...input, brief: "", ...pageSets(state), failure: reason }),
};

function pageSets(state: PdfRunState | undefined): Pick<PdfResult, "pagesRead" | "pagesConsulted"> {
	return {
		pagesRead: [...(state?.read ?? [])].sort((a, b) => a - b),
		pagesConsulted: [...(state?.consulted ?? [])].sort((a, b) => a - b),
	};
}
