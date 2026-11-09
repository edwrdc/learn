/**
 * The researcher sub-agent (vision §2.5): a SEPARATE durable child
 * conversation from the teacher — an isolated loop with only web_search +
 * web_fetch, so raw search/fetch churn never touches the teacher's context
 * window.
 *
 * System prompt adapted from the pi researcher agent
 * (~/.pi/agent/extensions/interactive-subagents/agents/researcher.md).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createPdfReadTools, createWebTools, type AppTool } from "../../tools/index.ts";
import type { ResearchRunState } from "../durable-run.ts";
import type { ResearchResult, ResearchToolInput } from "../model/types.ts";
import type { JobRole } from "./role.ts";

const RESEARCHER_INSTRUCTIONS = `You are a research specialist. You work for a teacher agent inside a learning
application: given a research question, conduct thorough web research and produce a focused,
well-sourced brief that the teacher can teach from.

You operate in an isolated context with no knowledge of the lesson or any prior conversation.
All necessary context is in the task description.

Process:
1. Break the question into 2-4 searchable facets.
2. Search with web_search using varied angles:
   - the direct answer query (the obvious one)
   - an authoritative-source query (official docs, specs, primary sources)
   - a practical-experience query (case studies, benchmarks, real-world usage)
   - a recent-developments query (only if the topic is time-sensitive)
3. Read the results. Identify what's well-covered and what has gaps. If the first round
   doesn't fully answer the question, search again with refined queries targeting the gaps.
4. For the 2-3 most promising source URLs, use web_fetch to get the full page content.
5. PDF sources: when web_fetch says a URL is a PDF, call web_fetch_pdf on it — it downloads
   and triages the document (page count, size class, flagged pages). Then read it with
   pdf_extract — for long ones, pdf_search first and extract only the pages that hit.
   Cite claims from a PDF as (p. N).
6. Synthesize everything into a brief that directly answers the question.

Evaluation — what to keep vs drop:
- Official docs and primary sources outweigh blog posts and forum threads.
- Recent sources outweigh stale ones.
- Sources that directly address the question outweigh tangentially related ones.
- Drop SEO filler, outdated info, and beginner tutorials (unless that's the audience).

Tool outputs may be error strings (e.g. search unconfigured, a page that failed to fetch).
Adapt: try another URL or another search angle; if research is genuinely impossible, say so
in the brief instead of inventing facts.

If web_search reports that search is unavailable because credentials are missing, do not retry it with different queries. Use web_fetch when you have source URLs, and continue with any other available sources. If the missing search capability materially limits your work, state the limitation and the missing-key setup needed in your brief. Never invent search results or sources.

Your FINAL assistant message is your entire deliverable — it must stand alone, using this format:

## Summary
2-3 sentence direct answer.

## Findings
Numbered findings with inline source citations:
1. **Finding** — explanation. [Source](url)

## Sources
- Kept: Source Title (url) — why relevant
- Dropped: Source Title — why excluded

## Gaps
What couldn't be answered. Suggested next steps.`;

/** The job's activity line for one tool call. */
function activityLine(toolName: string, args: unknown): string {
	const input = args as { query?: string; url?: string } | undefined;
	if (toolName === "web_search") return `web_search: "${input?.query ?? ""}"`;
	if (toolName === "web_fetch" || toolName === "web_fetch_pdf") {
		try {
			return `${toolName}: ${new URL(String(input?.url)).hostname}`;
		} catch {
			return toolName;
		}
	}
	return toolName;
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url.slice(0, 40);
	}
}

/** Sources for the result: markdown links cited in the brief, else fetched URLs. */
function parseSources(brief: string, fetchedUrls: string[]): ResearchResult["sources"] {
	const sources: ResearchResult["sources"] = [];
	const seen = new Set<string>();
	for (const match of brief.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
		const title = (match[1] ?? "").trim();
		const url = match[2]!;
		if (!title || seen.has(url)) continue;
		seen.add(url);
		sources.push({ title, url });
	}
	if (sources.length === 0) {
		for (const url of fetchedUrls) {
			if (seen.has(url)) continue;
			seen.add(url);
			sources.push({ title: hostOf(url), url });
		}
	}
	return sources.slice(0, 10);
}

export const RESEARCH_ROLE: JobRole<ResearchToolInput, ResearchResult, ResearchRunState> = {
	kind: "research",
	model: "researcher",
	maxTurns: 12,
	instructions: RESEARCHER_INSTRUCTIONS,
	activity: "researching",
	initialState: () => ({ kind: "research", fetchedUrls: [] }),
	/** The web tools, plus the PDF tools scoped to the job's own download
	 *  directory. Each call commits the fetched URL before its result. */
	tools(run) {
		const tools: Record<string, AppTool<any>> = { ...createWebTools(run.host.search) };
		const pdfDir = run.input.pdfDir;
		if (typeof pdfDir === "string" && pdfDir.length > 0) Object.assign(tools, createPdfReadTools(pdfDir));
		return Object.fromEntries(
			Object.entries(tools).map(([name, tool]) => [
				name,
				{
					...tool,
					async execute(toolCallId, args, signal) {
						const result = await tool.execute(toolCallId, args, signal);
						const url = (args as { url?: unknown } | undefined)?.url;
						if (typeof url === "string" && (name === "web_fetch" || name === "web_fetch_pdf") && !result.isError) {
							await run.state.update((state) => {
								if (!state.fetchedUrls.includes(url)) state.fetchedUrls.push(url);
							});
						}
						run.host.onActivity?.(activityLine(name, args));
						return result;
					},
				} satisfies AppTool<any>,
			]),
		);
	},
	input: (raw) => ({
		question: typeof raw?.question === "string" && raw.question.trim() ? raw.question : "(no question)",
		...(typeof raw?.context === "string" && raw.context.trim() ? { context: raw.context } : {}),
	}),
	prompt: (input) =>
		[
			`Research question: ${input.question}`,
			input.context ? `Context (what this is needed for): ${input.context}` : null,
			"Produce your final brief in the required format.",
		]
			.filter(Boolean)
			.join("\n\n"),
	runInput: (input) => ({ ...input }),
	/** web_fetch_pdf downloads land in a per-job directory that dies with the job. */
	async workspace(run) {
		const pdfDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-research-"));
		try {
			return await run({ pdfDir });
		} finally {
			await fs.rm(pdfDir, { recursive: true, force: true });
		}
	},
	async finish(input, outcome) {
		const brief = outcome.text.trim();
		if (!brief) return RESEARCH_ROLE.failure(input, "the researcher produced no text");
		return { brief, sources: parseSources(brief, outcome.state.fetchedUrls) };
	},
	failure: (_input, reason) => ({ brief: "", sources: [], failure: reason }),
};
