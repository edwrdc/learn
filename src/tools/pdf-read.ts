import * as fs from "node:fs/promises";
import { USER_AGENT, isHttpUrl } from "./web/web.ts";
import * as path from "node:path";
import { Type } from "typebox";
import type { AppTool } from "./adapter.ts";
import { serverExecute } from "./execute.ts";
import { pdfExtract, pdfInfo, pdfProbe, pdfSearch } from "./pdf-ops.ts";

/**
 * PDF reading tools for the researcher sub-agent (owner decision): web
 * PDFs with the pdf-reader's text capabilities (pdf_info / pdf_extract /
 * pdf_search) in the researcher's own loop, so page-cited content lands in
 * the brief directly.
 *
 * web_fetch_pdf downloads the file (size-capped, probe-validated) into a
 * per-job temp dir; every path-taking tool is scoped to that dir. pdf_render
 * is deliberately absent: the researcher's model slot has no vision.
 *
 * Like web.ts, every failure path returns an error string instead of
 * throwing.
 */

const FETCH_TIMEOUT_MS = 60_000;
/** PDFs run bigger than pages — arxiv papers routinely 5-20 MB. */
const MAX_PDF_BYTES = 25 * 1024 * 1024;

/** The pdf-reader doctrine's size classes, by page count. */
function sizeClass(pageCount: number): "short" | "medium" | "long" {
	if (pageCount <= 10) return "short";
	if (pageCount <= 40) return "medium";
	return "long";
}

/** Pages worth a look before any extraction — math- or image-heavy. */
function flaggedPages(info: Awaited<ReturnType<typeof pdfInfo>>): number[] {
	return info.pages
		.filter((p) => p.math_density >= 0.03 || p.image_count > 0)
		.slice(0, 30)
		.map((p) => p.page);
}

/** Resolve a tool-supplied path and require it to live INSIDE the job's
 *  pdf dir — the researcher's filesystem ends at the temp dir's wall. */
function scopedPath(dir: string, filePath: string): string | null {
	const root = path.resolve(dir) + path.sep;
	const resolved = path.resolve(dir, filePath);
	if (!resolved.startsWith(root)) return null;
	return resolved;
}

/** Filename for a downloaded PDF — slug from the URL's last segment plus a
 *  unique suffix (two PDFs from different URLs never collide). */
function pdfFileName(url: string): string {
	try {
		const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "document";
		const slug = last.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-80) || "document";
		const stem = slug.replace(/\.pdf$/i, "");
		return `${stem}-${Math.random().toString(36).slice(2, 8)}.pdf`;
	} catch {
		return `document-${Math.random().toString(36).slice(2, 8)}.pdf`;
	}
}

/** The download + triage summary the researcher sees from web_fetch_pdf. */
interface PdfFetchSummary {
	path: string;
	url: string;
	page_count: number;
	size_class: "short" | "medium" | "long";
	mean_text_length: number;
	flagged_pages: number[];
}

export function createPdfReadTools(dir: string): Record<string, AppTool<any>> {
	const pdfFetchInput = Type.Object({
		url: Type.String({ description: "The PDF URL to download" }),
	});
	const pdfPathInput = Type.Object({
		path: Type.String({ description: "The local PDF path returned by web_fetch_pdf" }),
	});
	const pdfExtractInput = Type.Object({
		path: Type.String({ description: "The local PDF path returned by web_fetch_pdf" }),
		pages: Type.String({
			description: "Pages to extract: 'all', '1-5', '1,3,7', or '3'. Use pdf_info first; narrow the spec for big documents.",
		}),
	});
	const pdfSearchInput = Type.Object({
		path: Type.String({ description: "The local PDF path returned by web_fetch_pdf" }),
		query: Type.String({ description: "Text to find (case-insensitive substring)" }),
	});

	return {
		web_fetch_pdf: {
			name: "web_fetch_pdf",
			description:
				"Download a PDF from the web and triage it: returns its local path, page count, size class " +
				"(short ≤10 pages, medium ≤40, long), and flagged (math/image-heavy) pages. " +
				"Then read it with pdf_extract / pdf_search. Use when web_fetch reports a URL is a PDF.",
			parameters: pdfFetchInput,
			execute: serverExecute("web_fetch_pdf", pdfFetchInput, async ({ url }): Promise<PdfFetchSummary | string> => {
				if (!isHttpUrl(url)) return `web_fetch_pdf failed: invalid URL "${url}"`;
				try {
					const resp = await fetch(url, {
						headers: {
							"User-Agent": USER_AGENT,
							Accept: "application/pdf,application/octet-stream,*/*",
						},
						signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
					});
					if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
					const contentType = resp.headers.get("content-type") ?? "";
					if (!/application\/pdf/i.test(contentType) && !/\.pdf(\?|$)/i.test(parsedPathname(url))) {
						throw new Error(`Not a PDF (content-type ${contentType.split(";")[0] || "unknown"})`);
					}
					const declared = Number(resp.headers.get("content-length") ?? 0);
					if (declared > MAX_PDF_BYTES) throw new Error("PDF too large (over 25 MB)");
					const bytes = new Uint8Array(await resp.arrayBuffer());
					if (bytes.length === 0) throw new Error("Empty response");
					if (bytes.length > MAX_PDF_BYTES) throw new Error("PDF too large (over 25 MB)");
					const filePath = path.join(dir, pdfFileName(url));
					await fs.writeFile(filePath, bytes);
					try {
						await pdfProbe(filePath);
					} catch {
						await fs.rm(filePath, { force: true });
						throw new Error("The download is not a readable PDF");
					}
					const info = await pdfInfo(filePath);
					const summary: PdfFetchSummary = {
						path: filePath,
						url,
						page_count: info.page_count,
						size_class: sizeClass(info.page_count),
						mean_text_length: info.mean_text_length,
						flagged_pages: flaggedPages(info),
					};
					return summary;
				} catch (err) {
					return `web_fetch_pdf failed for ${url}: ${err instanceof Error ? err.message : String(err)}`;
				}
			}),
		},

		pdf_info: {
			name: "pdf_info",
			description:
				"Triage a downloaded PDF: page count plus per-page signals (text_length, image_count, math_density).",
			parameters: pdfPathInput,
			execute: serverExecute("pdf_info", pdfPathInput, async ({ path: filePath }) => {
				const scoped = scopedPath(dir, filePath);
				if (!scoped) return `pdf_info failed: path must stay inside this job's download dir`;
				try {
					const info = await pdfInfo(scoped);
					return {
						page_count: info.page_count,
						mean_text_length: info.mean_text_length,
						size_class: sizeClass(info.page_count),
						pages: info.pages,
					};
				} catch (err) {
					return `pdf_info failed: ${err instanceof Error ? err.message : String(err)}`;
				}
			}),
		},

		pdf_extract: {
			name: "pdf_extract",
			description:
				"Extract text from pages of a downloaded PDF (spec: 'all', '1-5', '1,3,7', '3'). " +
				"Use pdf_info first; narrow the spec for big documents.",
			parameters: pdfExtractInput,
			execute: serverExecute("pdf_extract", pdfExtractInput, async ({ path: filePath, pages }) => {
				const scoped = scopedPath(dir, filePath);
				if (!scoped) return `pdf_extract failed: path must stay inside this job's download dir`;
				try {
					return await pdfExtract(scoped, pages);
				} catch (err) {
					return `pdf_extract failed: ${err instanceof Error ? err.message : String(err)}`;
				}
			}),
		},

		pdf_search: {
			name: "pdf_search",
			description: "Find text in a downloaded PDF — returns the pages and contexts that hit.",
			parameters: pdfSearchInput,
			execute: serverExecute("pdf_search", pdfSearchInput, async ({ path: filePath, query }) => {
				const scoped = scopedPath(dir, filePath);
				if (!scoped) return `pdf_search failed: path must stay inside this job's download dir`;
				try {
					const { hits } = await pdfSearch(scoped, query, { literal: true });
					return { hits };
				} catch (err) {
					return `pdf_search failed: ${err instanceof Error ? err.message : String(err)}`;
				}
			}),
		},
	};
}

function parsedPathname(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return "";
	}
}
