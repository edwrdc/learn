import { Type } from "typebox";
import type { AppTool, AppToolResult } from "../tool-adapter.ts";
import {
	backgroundRun,
	type DemoRunState,
	type DemoVerification,
	type RoleRunIdentity,
	type RoleStateIo,
} from "./durable-run.ts";
import type { DemoResult } from "../../core/contracts.ts";
import { getHeadless, type DemoRunResult, type HeadlessApi } from "./headless.ts";
import type { PiEngine } from "../models.ts";

/**
 * The demo-builder sub-agent (vision §2 interactive demos + §2.5 "sub-agents
 * verify; they never one-shot"): given a brief it writes a self-contained
 * single-file HTML/JS demo, TESTS IT HEADLESSLY (run_demo), and iterates
 * fix → re-run until clean — before anything reaches the lesson.
 *
 * The model loop is a durable conversation (durable-run.ts): the two tools
 * commit their progress into the run descriptor before their results, so a
 * process death mid-build resumes with the same html/tested state. The final
 * headless verification stays in the finish path below: the delivered html
 * must have a clean run even when the model claims success or forgets the
 * final run_demo.
 *
 * Failure semantics (decided in the W6 brief): `tested: true` means "the
 * verify loop ran"; on failure the result is { title, html: "", tested: true,
 * notes: "FAILED: <reason>" } — the card renders the failure note, no iframe.
 * The job wrapper treats html === "" as failure and marks the job error.
 */

export interface DemoBuilderInput {
	title: string;
	brief: string;
}

export interface DemoBuilderOptions {
	/** Test seam: scripted engine; production uses the demoBuilder role. */
	engine?: PiEngine;
	headless?: HeadlessApi;
	/** Max agent steps (each write/run/fix is one step). Default 24 ≈ 6 cycles. */
	maxSteps?: number;
	/** Live activity-line callback (updates the job record). */
	onActivity?: (line: string) => void;
	/** Kills the run mid-model-call (2026-09 real-kill abort semantics). */
	abortSignal?: AbortSignal;
	/** Money channel: folded per assistant step into JobRecord.usage. */
	onUsage?: (usage: import("../../core/contracts.ts").JobUsage) => void;
	/** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
	chatId?: string;
	/** The durable owner + stable run key (the job id in production). */
	run: RoleRunIdentity;
}

const INSTRUCTIONS = `You are a demo builder — a specialist sub-agent inside a learning application. You
receive a brief for ONE interactive teaching instrument and deliver a single self-contained HTML document
that runs it. You never see the lesson; the brief is everything you know.

Runtime contract (the document runs in a sandboxed iframe, sandbox="allow-scripts", opaque origin):
- Single file. Vanilla JS + Canvas 2D or SVG. CDN imports (e.g. a plotting or math library) are allowed
  when they genuinely help — but prefer dependency-free; you own the failure if a CDN import fails.
- NO localStorage, sessionStorage, or document.cookie — the sandbox makes them throw.
- The parent sizes the iframe to the document height automatically; just build normal flowing layout.
  Make the demo fill the width and size its own height sensibly.

Build quality:
- The demo must directly serve the brief: every control named in the brief must exist and do the thing.
- Controls need labels; sliders/inputs need current-value readouts. A learner should operate it unguided.
- Smooth enough interaction; requestAnimationFrame for animation, not setInterval when it matters.
- Dark-mode neutral: pick a clean light background for the demo area so it reads on any card.

THE HOUSE RULE — never deliver untested:
1. Call write_demo with the complete HTML document.
2. Call run_demo. It loads the file in a headless browser, waits ~2s, and reports console errors, uncaught
   errors (window.onerror), and failed requests. Optionally pass a probe: a JS expression evaluated in
   the page (e.g. "typeof window.simulate === 'function'" or a state assertion) to check deeper.
3. If run_demo reports problems, FIX the document and call write_demo again, then run_demo again.
   Iterate until run_demo reports PASSED.
4. Only then finish. Your final message is 1-3 sentences of NOTES for the teacher (what the demo shows,
   its controls, what to try) — NEVER the HTML itself.

Never claim success you did not see: a PASSED run_demo is the only definition of done.`;

const writeDemoInput = Type.Object({
	html: Type.String({ description: "The complete HTML document: <!doctype html>…</html>, all JS inline." }),
});

const runDemoInput = Type.Object({
	probe: Type.Optional(
		Type.String({
			description:
				"Optional JS expression evaluated in the page after settling, e.g. \"document.querySelectorAll('input').length\".",

		}),
	),
});

function textResult(text: string): AppToolResult {
	return { content: [{ type: "text", text }] };
}

/** The probe value is not persisted (it is an arbitrary JSON value the model
 *  asked for); the verification facts are. */
function verification(result: DemoRunResult): DemoVerification {
	return {
		consoleErrors: result.consoleErrors,
		pageErrors: result.pageErrors,
		failedRequests: result.failedRequests,
		ok: result.ok,
	};
}

export function demoRoleTools(
	io: RoleStateIo<DemoRunState>,
	headless: HeadlessApi,
	onActivity?: (line: string) => void,
): Record<string, AppTool<any>> {
	return {
		write_demo: {
			name: "write_demo",
			description:
				"Write the complete self-contained HTML document for the demo (overwrites any previous version). " +
				"Always follow with run_demo to test it headlessly.",
			parameters: writeDemoInput,
			executionMode: "sequential",
			async execute(_toolCallId, raw) {
				const { html } = raw as { html: string };
				if (!html || html.trim().length === 0) return textResult("ERROR: empty document — write the full HTML.");
				await io.update((state) => {
					state.html = html;
				});
				onActivity?.(`write_demo: ${(html.length / 1024).toFixed(1)} KB`);
				return textResult(`Saved (${html.length} bytes). Now call run_demo to test it — never deliver untested.`);
			},
		},
		run_demo: {
			name: "run_demo",
			description:
				"Headlessly execute the current demo in a browser and report console errors, uncaught errors, and failed requests. " +
				"Optionally pass a probe expression to assert on page state.",
			parameters: runDemoInput,
			executionMode: "sequential",
			async execute(_toolCallId, raw) {
				const probe = (raw as { probe?: string }).probe;
				const html = (await io.read()).html;
				if (!html) return textResult("ERROR: nothing to run — call write_demo first.");
				const reason = headless.unavailableReason();
				if (reason) return textResult(`HEADLESS UNAVAILABLE: ${reason}`);
				let result: DemoRunResult;
				try {
					result = await headless.runDemo(html, probe ? { probe } : undefined);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					onActivity?.("run_demo: browser error");
					return textResult(`HEADLESS ERROR (retrying may help): ${msg}`);
				}
				await io.update((state) => {
					state.testedHtml = html;
					state.lastResult = verification(result);
				});
				onActivity?.(result.ok ? "run_demo: clean" : `run_demo: ${summarizeCounts(result)}`);
				return textResult(formatRunResult(result));
			},
		},
	};
}

function summarizeCounts(result: DemoRunResult | DemoVerification): string {
	const counts = [
		result.consoleErrors.length > 0 ? `${result.consoleErrors.length} console error${result.consoleErrors.length === 1 ? "" : "s"}` : null,
		result.pageErrors.length > 0 ? `${result.pageErrors.length} page error${result.pageErrors.length === 1 ? "" : "s"}` : null,
		result.failedRequests.length > 0 ? `${result.failedRequests.length} failed request${result.failedRequests.length === 1 ? "" : "s"}` : null,
	].filter(Boolean);
	return counts.length > 0 ? counts.join(", ") : "ok";
}

function formatRunResult(result: DemoRunResult): string {
	if (result.ok) {
		const probe =
			result.probeResult !== undefined
				? ` Probe result: ${JSON.stringify(result.probeResult) ?? "undefined"}.`
				: "";
		return `PASSED: no console errors, no uncaught errors, no failed requests.${probe} If you are satisfied, finish with your notes; otherwise keep improving and re-test.`;
	}
	const sections: string[] = [`FAILED: ${summarizeCounts(result)}.`];
	if (result.consoleErrors.length > 0)
		sections.push(`Console errors:\n${result.consoleErrors.slice(0, 10).map((e) => `- ${e}`).join("\n")}`);
	if (result.pageErrors.length > 0)
		sections.push(`Uncaught errors:\n${result.pageErrors.slice(0, 10).map((e) => `- ${e}`).join("\n")}`);
	if (result.failedRequests.length > 0)
		sections.push(`Failed requests:\n${result.failedRequests.slice(0, 10).map((r) => `- ${r}`).join("\n")}`);
	sections.push("Fix the document (write_demo) and re-test (run_demo).");
	return sections.join("\n");
}

/** Short summary of a run for failure notes. */
function failureSummary(result: DemoVerification | null): string {
	if (!result) return "never tested";
	const details = [...result.consoleErrors, ...result.pageErrors, ...result.failedRequests].slice(0, 5);
	return details.length > 0 ? `${summarizeCounts(result)} — ${details.join(" | ")}` : summarizeCounts(result);
}

export async function runDemoBuilder(input: DemoBuilderInput, opts: DemoBuilderOptions): Promise<DemoResult> {
	const headless = opts.headless ?? getHeadless();
	const title = input.title.trim() || "Interactive demo";
	const brief = input.brief.trim() || "(no brief)";
	const notes = (text: string) => (text.trim() ? text.trim() : undefined);

	const reason = headless.unavailableReason();
	if (reason) {
		return { title, html: "", tested: true, notes: `FAILED: ${reason}` };
	}
	if (!opts.run) throw new Error("demo builder: a durable run identity is required (chatId + jobId)");
	if (!opts.engine) throw new Error("demo builder: no model engine was resolved");

	const prompt = [
		`Demo title: ${title}`,
		`Brief (all you know about the lesson — this comes from the teacher, verbatim):`,
		brief,
		"",
		"Build the demo, test it with run_demo, iterate until PASSED, then finish with your notes.",
	].join("\n");

	let finalText = "";
	let state: DemoRunState;
	try {
		const outcome = await backgroundRun({
			jobId: opts.run.jobId,
			chatId: opts.run.chatId,
			kind: "demo",
			role: "demoBuilder",
			engine: opts.engine,
			maxTurns: opts.maxSteps ?? 24,
			systemPrompt: INSTRUCTIONS,
			prompt,
			input: { title, brief },
			headless,
			signal: opts.abortSignal,
			onActivity: opts.onActivity,
			onUsage: opts.onUsage,
		});
		finalText = outcome.text;
		state = outcome.state as DemoRunState;
	} catch (err) {
		// A caller abort keeps the old loop's failure shape (the job runner's
		// abort path ignores the result). An AbortError WITHOUT a caller
		// abort is a runtime close: rethrow so the job unwinds recoverable.
		if (!opts.abortSignal?.aborted && err instanceof Error && err.name === "AbortError") throw err;
		const msg = err instanceof Error ? err.message : String(err);
		return { title, html: "", tested: true, notes: `FAILED: the builder crashed — ${msg}` };
	}

	// The model produced nothing.
	if (!state.html) {
		return {
			title,
			html: "",
			tested: true,
			notes: `FAILED: the builder never wrote a demo.${finalText ? ` (${finalText.slice(0, 300)})` : ""}`,
		};
	}

	// The verify gate: the delivered html must have a clean headless run —
	// even when the model claims success or forgets the final run_demo.
	if (state.testedHtml !== state.html || !state.lastResult?.ok) {
		opts.onActivity?.("final verification");
		let verify: DemoRunResult;
		try {
			verify = await headless.runDemo(state.html);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { title, html: "", tested: true, notes: `FAILED: final verification crashed — ${msg}` };
		}
		state.lastResult = verification(verify);
		if (!verify.ok) {
			return {
				title,
				html: "",
				tested: true,
				notes: `FAILED: the demo never passed headless verification (${failureSummary(state.lastResult)}).`,
			};
		}
	}

	return { title, html: state.html, tested: true, notes: notes(finalText) };
}
