import { Type } from "typebox";
import { serverExecute } from "../../tools/index.ts";
import type { VisualRunState } from "../durable-run.ts";
import type { VisualResult } from "../model/types.ts";
import type { VisualInput } from "../tools.ts";
import type { JobRole } from "./role.ts";

/**
 * The visual-maker sub-agent: authors ONE precise SVG from a brief, renders
 * it to a PNG, LOOKS at the result, and iterates until correct — a direct port
 * of the vault POC's svg-maker doctrine ("the one rule that matters: verify
 * by looking").
 *
 * render_svg only marks a render pending; `afterTools` renders it and shows
 * the image after the round's tool results. `onYield` is the doctrine gate:
 * a finish whose current SVG was never rendered renders it, shows the image,
 * and asks the model to look before finishing.
 */

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

const VISUAL_LOOK_MESSAGE =
	"Here is the current render of your SVG — inspect it critically (geometry, labels, clipping, readability):";
const VISUAL_UNLOOKED_MESSAGE =
	"You finished without looking at a render of your final SVG. Above is its render. If it is correct and clean, reply with just your notes; otherwise call write_svg with fixes and render again.";

const writeSvgInput = Type.Object({
	svg: Type.String({ description: 'Complete <svg xmlns="…">…</svg> markup.' }),
});

const editSvgInput = Type.Object({
	old_text: Type.String({ description: "The exact text to replace — must match exactly once in the current SVG." }),
	new_text: Type.String({ description: "The replacement text." }),
});

const renderSvgInput = Type.Object({});

function imageOf(png: Buffer): { type: "image"; data: string; mimeType: string } {
	return { type: "image", data: png.toString("base64"), mimeType: "image/png" };
}

export const VISUAL_ROLE: JobRole<VisualInput, VisualResult, VisualRunState> = {
	kind: "visual",
	model: "visualMaker",
	maxTurns: 8,
	instructions: INSTRUCTIONS,
	activity: "drawing figure",
	crashed: "the maker crashed",
	initialState: () => ({ kind: "visual", currentSvg: null, renderedSvg: null, pendingRender: false }),
	tools: ({ state, host }) => ({
		write_svg: {
			name: "write_svg",
			description: "Write the complete SVG source for the figure (overwrites any previous version).",
			parameters: writeSvgInput,
			executionMode: "sequential",
			execute: serverExecute("write_svg", writeSvgInput, async ({ svg }) => {
				if (typeof svg !== "string" || !svg.includes("<svg")) {
					return "ERROR: expected a complete <svg>…</svg> document in the `svg` field.";
				}
				await state.update((next) => {
					next.currentSvg = svg;
				});
				host.onActivity?.(`write_svg: ${(svg.length / 1024).toFixed(1)} KB`);
				return `Saved (${svg.length} bytes). Call render_svg to look at it.`;
			}),
		},
		edit_svg: {
			name: "edit_svg",
			description:
				"Replace one exact spot in the current SVG: old_text must appear EXACTLY ONCE and is replaced by new_text. Call write_svg first. For larger changes, write_svg the whole document.",
			parameters: editSvgInput,
			executionMode: "sequential",
			execute: serverExecute("edit_svg", editSvgInput, async (edit) => {
				const currentSvg = (await state.read()).currentSvg;
				if (!currentSvg) return "ERROR: nothing to edit — call write_svg first.";
				if (typeof edit.old_text !== "string" || typeof edit.new_text !== "string" || !edit.old_text) {
					return "ERROR: expected old_text (non-empty) and new_text strings.";
				}
				const occurrences = currentSvg.split(edit.old_text).length - 1;
				if (occurrences === 0) {
					return `ERROR: old_text not found. Closest line for reference:\n${snippetAround(currentSvg, edit.old_text)}`;
				}
				if (occurrences > 1) {
					return `ERROR: old_text appears ${occurrences} times — it must match EXACTLY ONCE. Include more surrounding context to make it unique.`;
				}
				await state.update((next) => {
					next.currentSvg = currentSvg.replace(edit.old_text, edit.new_text);
				});
				host.onActivity?.("edit_svg: applied");
				return "OK — replaced 1 occurrence. Call render_svg to look at the edited SVG.";
			}),
		},
		render_svg: {
			name: "render_svg",
			description: "Render the current SVG to a PNG and show it to you for inspection. No arguments.",
			parameters: renderSvgInput,
			executionMode: "sequential",
			execute: serverExecute("render_svg", renderSvgInput, async () => {
				if (!(await state.read()).currentSvg) return "ERROR: nothing to render — call write_svg first.";
				await state.update((next) => {
					next.pendingRender = true;
				});
				host.onActivity?.("render_svg: inspecting render");
				return "Rendered — the PNG follows in the next message. Look at it.";
			}),
		},
	}),
	/** The pending render, shown after the round's tool results (a
	 *  last-iteration image must not go unseen). */
	async afterTools({ state, host }) {
		const { pendingRender, currentSvg } = await state.read();
		if (!pendingRender || !currentSvg) return;
		let png: Buffer;
		try {
			png = await host.headless.renderSvg(currentSvg);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await state.update(
				(next) => {
					next.pendingRender = false;
				},
				`RENDER ERROR (the SVG may be malformed): ${msg}. Fix it with write_svg and render again.`,
			);
			return;
		}
		await state.update(
			(next) => {
				next.pendingRender = false;
				next.renderedSvg = currentSvg;
			},
			[{ type: "text", text: VISUAL_LOOK_MESSAGE }, imageOf(png)],
		);
	},
	/** Never finish without having looked at the final SVG. */
	async onYield(run) {
		const { currentSvg, renderedSvg } = await run.state.read();
		if (!currentSvg || renderedSvg === currentSvg) return undefined;
		if ((await run.turnsTaken()) + 1 >= run.maxTurns) {
			await run.markCapped();
			return undefined;
		}
		let png: Buffer;
		try {
			png = await run.host.headless.renderSvg(currentSvg);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await run.state.update((next) => {
				next.renderError = msg;
			});
			return undefined;
		}
		await run.state.update((next) => {
			next.renderedSvg = currentSvg;
		});
		return [{ type: "text", text: VISUAL_UNLOOKED_MESSAGE }, imageOf(png)];
	},
	input: (raw) => ({ brief: typeof raw?.brief === "string" && raw.brief.trim() ? raw.brief.trim() : "(no brief)" }),
	prompt: ({ brief }) =>
		[
			"Brief for ONE precise figure (from the teacher, verbatim — it is everything you know):",
			brief,
			"",
			"Author the SVG, render it, look at it, iterate until correct, then finish with your notes.",
		].join("\n"),
	async finish(input, { text, state, capped, maxTurns }) {
		if (state.renderError) return VISUAL_ROLE.failure(input, `rendering the final SVG failed — ${state.renderError}`);
		if (!state.currentSvg) {
			return VISUAL_ROLE.failure(input, `the maker never wrote an SVG.${text ? ` (${text.slice(0, 300)})` : ""}`);
		}
		if (state.renderedSvg !== state.currentSvg) {
			return VISUAL_ROLE.failure(
				input,
				capped
					? `iteration limit (${maxTurns}) reached without a verified SVG.`
					: "the maker finished without looking at its final SVG.",
			);
		}
		const notes = text || (capped ? "Iteration limit reached — delivering the last verified SVG." : undefined);
		return { svg: state.currentSvg, ...(notes ? { notes } : {}) };
	},
	failure: (_input, reason) => ({ svg: "", failure: reason }),
};

/** A 3-line numbered context window around the closest fuzzy match for a
 *  failed edit — enough for the model to see what went wrong and retry
 *  (the pi svg_tools snippetAround semantics). */
function snippetAround(svg: string, target: string): string {
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
