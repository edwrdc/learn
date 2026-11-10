/** Everything the teacher reads about a job kind: the dispatch tool's
 *  description, the ack after a dispatch, and the steer text for a result,
 *  a failure and an abort. One entry per kind. */

import type { JobKind } from "../../tools/model/index.ts";
import type { DemoResult, JobResult, PdfResult, ResearchResult, VisualResult } from "./types.ts";

interface JobText {
	description: string;
	/** Follows "Dispatched (job <id>). " in the tool result. */
	ack: string;
	done(result: JobResult): string;
	failed(result: JobResult): string;
	aborted: string;
}

const FIRE_AND_FORGET = "This call is fire-and-forget: continue your turn and keep teaching — do not wait, poll, or mention waiting. ";

export const JOB_TEXT: Record<JobKind, JobText> = {
	research: {
		description:
			"Dispatch a background web-research agent: fact verification, current data, or niche specifics you are not certain about. " +
			"The call is ASYNC and fire-and-forget — it resolves immediately and your turn continues; the research brief arrives later " +
			"as a new message and the lesson resumes from it. Cite the brief's sources when you use them. " +
			"NEVER use it for things you know cold, internal reasoning, or math.",
		ack: FIRE_AND_FORGET + "The researched brief arrives as a new message when ready and the lesson resumes from it; cite its sources when you use them.",
		done: (result) =>
			`Research complete — the researcher's full brief follows. Weave it into the lesson and cite its sources when you use its findings:\n\n${(result as ResearchResult).brief}`,
		failed: (result) =>
			`Research failed: ${result.failure}\n\nContinue with what you can establish and flag the uncertainty to the learner.`,
		aborted:
			"Research aborted — the learner aborted the research job, so no brief is coming. Acknowledge it in one line and continue teaching without it (or offer to re-dispatch it).",
	},
	demo: {
		description:
			"Dispatch a background sub-agent that BUILDS and headlessly TESTS an interactive teaching instrument — a single-file HTML " +
			"demo (parameter sweep, simulation, animation, sampling) rendered live in the lesson. Use it when the concept is DYNAMIC: " +
			"something to sweep, animate, or sample is better experienced than described. " +
			"The call is ASYNC and fire-and-forget — it resolves immediately and your turn continues; the tested demo arrives later " +
			"as a new message. Write a precise brief: concept, controls, interactions, style.",
		ack: FIRE_AND_FORGET + "The tested demo arrives as a new message when ready and is rendered in the lesson; teach with it then.",
		done: (result) =>
			`The demo "${(result as DemoResult).title}" is built, headlessly tested, and rendered in the lesson. Builder notes: ${
				(result as DemoResult).notes ?? "(none)"
			}.\nTeach with it — reference its controls by name and point the learner at what to try.`,
		failed: (result) =>
			`The demo "${(result as DemoResult).title}" could not be built: FAILED: ${result.failure}. Fall back to explaining in prose; if the brief was the problem, re-call demo with a tighter one.`,
		aborted:
			"The demo job was aborted by the learner — no demo is coming. Acknowledge it in one line and teach the topic in prose instead (a re-dispatch is fine if the learner wants it).",
	},
	visual: {
		description:
			"Dispatch a background sub-agent that hand-authors ONE precise SVG figure, renders it, LOOKS at the render, and iterates " +
			"until correct. Use it for exact spatial pictures auto-layout diagrams can't do: coordinate geometry, number lines, vectors, " +
			"function plots, physical layouts. For flows/relations/taxonomies write mermaid inline instead. " +
			"The call is ASYNC and fire-and-forget — it resolves immediately and your turn continues; the verified figure arrives later " +
			"as a new message.",
		ack: FIRE_AND_FORGET + "The verified figure arrives as a new message when ready and is rendered in the lesson; reference it then.",
		done: (result) =>
			`The figure is drawn, verified by inspection, and rendered in the lesson. Maker notes: ${
				(result as VisualResult).notes ?? "(none)"
			}.\nReference its elements as you teach.`,
		failed: (result) =>
			`The figure could not be made: FAILED: ${result.failure}. Fall back to prose or mermaid, or re-call visual with a tighter brief.`,
		aborted:
			"The figure job was aborted by the learner — no figure is coming. Acknowledge it in one line and teach without it (a re-dispatch is fine if the learner wants it).",
	},
	pdf: {
		description:
			"Dispatch a background sub-agent that READS a learner-provided PDF on your behalf (triage, targeted extraction, visual page " +
			"reading for equations and diagrams) and returns a brief with page citations. Use it when the learner gives you a PDF path " +
			"and you need its CONTENT for the lesson. The call is ASYNC and fire-and-forget — it resolves immediately and your turn " +
			"continues; the brief arrives later as a new message. For quick looks at plain text or image files, use the read tool " +
			"directly instead of dispatching.",
		ack: FIRE_AND_FORGET + "The document brief arrives as a new message when ready; weave it into the lesson and cite its pages.",
		done: (result) =>
			`PDF reading complete — the reader's brief on "${(result as PdfResult).path}" follows, with page citations. Weave it into the lesson and cite pages when you use it:\n\n${(result as PdfResult).brief}`,
		failed: (result) =>
			`PDF failed: ${result.failure}\n\nContinue with what you can establish from the session and flag the gap to the learner.`,
		aborted:
			"The PDF reading job was aborted by the learner — no brief is coming. Acknowledge it in one line and continue without it (a re-dispatch is fine if the learner wants it).",
	},
};
