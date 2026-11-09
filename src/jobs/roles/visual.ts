import { Type } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import type { AppTool } from "../../tools/index.ts";
import {
	backgroundRun,
	type RoleRunIdentity,
	type RoleStateIo,
	type VisualRunState,
	textResult,
} from "../durable-run.ts";
import type { VisualResult } from "../model/types.ts";
import { getHeadless, type HeadlessApi } from "../headless.ts";
import type { PiEngine } from "../../platform/index.ts";

/**
 * The visual-maker sub-agent (vision §2.5): authors ONE precise SVG from a
 * brief, renders it to a PNG with the same rasterizer the transcript
 * will use, LOOKS at the
 * result, and iterates until correct — a direct port of the vault POC's
 * svg-maker doctrine ("the one rule that matters: verify by looking").
 *
 * The loop is a durable conversation (durable-run.ts). The SVG and the last
 * rendered SVG live in the run descriptor; the image-in-the-loop message is
 * appended by the durable after-tools hook AFTER the tool results. The
 * doctrine gate is the run's
 * onYield hook: a finish whose current SVG was never rendered renders it,
 * shows the image, and asks the model to look before finishing.
 *
 * Failure semantics mirror the demo-builder: { svg: "", notes: "FAILED: …" }.
 */

export interface VisualMakerInput {
	brief: string;
}

export interface VisualMakerOptions {
	/** Test seam: scripted engine; production uses the visualMaker role. */
	engine?: PiEngine;
	headless?: HeadlessApi;
	/** Max model rounds (write/render cycles + final answer). Default 8. */
	maxIterations?: number;
	/** Live activity-line callback (updates the job record). */
	onActivity?: (line: string) => void;
	/** Kills the run mid-model-call (2026-09 real-kill abort semantics). */
	abortSignal?: AbortSignal;
	/** Money channel: folded per assistant step into JobRecord.usage. */
	onUsage?: (usage: import("../model/types.ts").JobUsage) => void;
	/** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
	chatId?: string;
	/** The durable owner + stable run key (the job id in production). */
	run: RoleRunIdentity;
}

const INSTRUCTIONS = `You are a visual maker — a diagram author + renderer for precise, spatial figures. You
receive a brief describing ONE idea that needs exact placement (coordinate geometry, number lines,
vectors, function plots, physical layouts — things auto-layout diagrams cannot express), and you return
ONE clean, correct SVG. You never see the lesson; the brief is everything you know.

You do NOT decide what idea to show — the teacher already decided. Your job is faithful, precise
composition, and above everything CORRECTNESS: the picture must not assert anything false. A right-angle
mark on the wrong corner, a vector pointing the wrong way, a point plotted at the wrong coordinate is a
failure even if it renders cleanly.

Your three tools:
- write_svg({ svg }) — write the complete <svg>…</svg> source (overwrites the previous version).
- edit_svg({ old_text, new_text }) — a surgical exact-match replacement in the current SVG:
  old_text must appear EXACTLY ONCE; it is replaced by new_text. Call write_svg first. For anything
  beyond a one-spot fix (new elements, restructured layout), write_svg the whole document again.
- render_svg({}) — rasterize the current SVG to a PNG. The render arrives as an image in the
  message right after the tool result.

THE ONE RULE THAT MATTERS MOST: verify by looking. You are done only when you have LOOKED at the
rendered PNG and confirmed it is true to the brief. Rendering success only proves the SVG parsed; it
says nothing about whether the geometry is right or the picture is readable. When you look:

- Is every coordinate, angle, direction, and proportion actually correct? Re-derive the geometry if unsure.
- Are labels placed clearly, not overlapping lines or each other?
- Is anything clipped by the viewBox, too small to read, or cramped?
- Would a learner instantly read the intended idea from this picture alone?

Workflow: plan the coordinate space (viewBox + margins, nothing touching the edges) → write_svg →
render_svg → LOOK critically → fix (edit_svg for one-spot fixes, write_svg otherwise) and re-render
until correct and clean. Never finish without having looked at a render of your FINAL SVG.

SVG requirements:
- A complete <svg> with explicit width/height AND a matching viewBox.
- White background (<rect> or style), dark strokes, sans-serif labels at generous sizes.
- One idea, fewest elements — sparse and large beats busy and tiny.
- Draw only what the brief specifies; never invent data, values, or shapes to fill space.
- Plain, clean styling: at most one accent color. An explanatory diagram, not art.

Your FINAL message: 1-2 sentences of notes for the teacher (what the figure shows, any caveats) —
NEVER the SVG source itself. If you genuinely cannot make a correct picture of the brief, say exactly
that in your final message and why.`;

export const VISUAL_LOOK_MESSAGE =
	"Here is the current render of your SVG — inspect it critically (geometry, labels, clipping, readability):";
export const VISUAL_UNLOOKED_MESSAGE =
	"You finished without looking at a render of your final SVG. Above is its render. If it is correct and clean, reply with just your notes; otherwise call write_svg with fixes and render again.";

export function visualRoleTools(
	io: RoleStateIo<VisualRunState>,
	headless: HeadlessApi,
	onActivity?: (line: string) => void,
): Record<string, AppTool<any>> {
	return {
		write_svg: {
			name: "write_svg",
			description: "Write the complete SVG source for the figure (overwrites any previous version).",
			parameters: Type.Object({
				svg: Type.String({ description: 'Complete <svg xmlns="…">…</svg> markup.' }),
			}),
			executionMode: "sequential",
			async execute(_toolCallId, { svg }) {
				if (typeof svg !== "string" || !svg.includes("<svg")) {
					return textResult("ERROR: expected a complete <svg>…</svg> document in the `svg` field.");
				}
				await io.update((state) => {
					state.currentSvg = svg;
				});
				onActivity?.(`write_svg: ${(svg.length / 1024).toFixed(1)} KB`);
				return textResult(`Saved (${svg.length} bytes). Call render_svg to look at it.`);
			},
		},
		edit_svg: {
			name: "edit_svg",
			description:
				"Replace one exact spot in the current SVG: old_text must appear EXACTLY ONCE and is replaced by new_text. Call write_svg first. For larger changes, write_svg the whole document.",
			parameters: Type.Object({
				old_text: Type.String({ description: "The exact text to replace — must match exactly once in the current SVG." }),
				new_text: Type.String({ description: "The replacement text." }),
			}),
			executionMode: "sequential",
			async execute(_toolCallId, raw) {
				const edit = raw as { old_text: string; new_text: string };
				const currentSvg = (await io.read()).currentSvg;
				if (!currentSvg) return textResult("ERROR: nothing to edit — call write_svg first.");
				if (typeof edit.old_text !== "string" || typeof edit.new_text !== "string" || !edit.old_text) {
					return textResult("ERROR: expected old_text (non-empty) and new_text strings.");
				}
				const occurrences = currentSvg.split(edit.old_text).length - 1;
				if (occurrences === 0) {
					return textResult(
						`ERROR: old_text not found. Closest line for reference:\n${snippetAround(currentSvg, edit.old_text)}`,
					);
				}
				if (occurrences > 1) {
					return textResult(
						`ERROR: old_text appears ${occurrences} times — it must match EXACTLY ONCE. Include more surrounding context to make it unique.`,
					);
				}
				await io.update((state) => {
					state.currentSvg = currentSvg.replace(edit.old_text, edit.new_text);
				});
				onActivity?.("edit_svg: applied");
				return textResult("OK — replaced 1 occurrence. Call render_svg to look at the edited SVG.");
			},
		},
		render_svg: {
			name: "render_svg",
			description: "Render the current SVG to a PNG and show it to you for inspection. No arguments.",
			parameters: Type.Object({}),
			executionMode: "sequential",
			async execute() {
				const state = await io.read();
				if (!state.currentSvg) return textResult("ERROR: nothing to render — call write_svg first.");
				const reason = headless.unavailableReason();
				if (reason) return textResult(`RENDER ERROR: ${reason}`);
				await io.update((next) => {
					next.pendingRender = true;
				});
				onActivity?.("render_svg: inspecting render");
				return textResult("Rendered — the PNG follows in the next message. Look at it.");
			},
		},
	};
}

/** The image-in-the-loop user message content (the durable hook appends it
 *  after the round's tool results). */
export function visualImageContent(png: Buffer): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
	return [
		{ type: "text", text: VISUAL_LOOK_MESSAGE },
		{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
	];
}

export async function runVisualMaker(input: VisualMakerInput, opts: VisualMakerOptions): Promise<VisualResult> {
	const headless = opts.headless ?? getHeadless();
	const brief = input.brief.trim() || "(no brief)";
	const maxIterations = opts.maxIterations ?? 8;

	const reason = headless.unavailableReason();
	if (reason) {
		return { svg: "", notes: `FAILED: ${reason}` };
	}
	if (!opts.run) throw new Error("visual maker: a durable run identity is required (chatId + jobId)");
	if (!opts.engine) throw new Error("visual maker: no model engine was resolved");

	const prompt = [
		"Brief for ONE precise figure (from the teacher, verbatim — it is everything you know):",
		brief,
		"",
		"Author the SVG, render it, look at it, iterate until correct, then finish with your notes.",
	].join("\n");

	let outcome;
	try {
		outcome = await backgroundRun({
			jobId: opts.run.jobId,
			chatId: opts.run.chatId,
			kind: "visual",
			role: "visualMaker",
			engine: opts.engine,
			maxTurns: maxIterations,
			systemPrompt: INSTRUCTIONS,
			prompt,
			input: { brief },
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
		return { svg: "", notes: `FAILED: the maker crashed — ${msg}` };
	}

	const state = outcome.state as VisualRunState;
	const finalText = outcome.text;
	if (state.renderError) {
		return { svg: "", notes: `FAILED: rendering the final SVG failed — ${state.renderError}` };
	}
	if (!state.currentSvg) {
		return {
			svg: "",
			notes: `FAILED: the maker never wrote an SVG.${finalText ? ` (${finalText.slice(0, 300)})` : ""}`,
		};
	}
	if (state.renderedSvg !== state.currentSvg) {
		return outcome.capped
			? { svg: "", notes: `FAILED: iteration limit (${maxIterations}) reached without a verified SVG.` }
			: { svg: "", notes: "FAILED: the maker finished without looking at its final SVG." };
	}
	return {
		svg: state.currentSvg,
		notes:
			finalText ||
			(outcome.capped ? "Iteration limit reached — delivering the last verified SVG." : undefined),
	};
}

/** A 3-line numbered context window around the closest fuzzy match for a
 *  failed edit — enough for the model to see what went wrong and retry
 *  (the pi svg_tools snippetAround semantics). */
export function snippetAround(svg: string, target: string): string {
	const words = target.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "(empty old_text)";
	const lines = svg.split("\n");
	let bestAt = -1;
	let bestScore = -1;
	for (let i = 0; i < lines.length; i++) {
		const score = words.filter((w) => lines[i]!.includes(w)).length;
		if (score > bestScore) {
			bestScore = score;
			bestAt = i;
		}
	}
	if (bestAt < 0) return "(no similar line found)";
	const from = Math.max(0, bestAt - 1);
	const to = Math.min(lines.length, bestAt + 2);
	return lines
		.slice(from, to)
		.map((line, idx) => `${from + idx + 1} | ${line}`)
		.join("\n");
}
