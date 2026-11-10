import { Type } from "typebox";
import { serverExecute } from "../../tools/index.ts";
import type { DemoRunState, DemoVerification } from "../durable-run.ts";
import type { DemoResult } from "../model/types.ts";
import type { DemoInput } from "../tools.ts";
import type { DemoRunResult } from "../headless.ts";
import type { JobRole } from "./role.ts";

/**
 * The demo-builder sub-agent ("sub-agents verify; they never one-shot"):
 * given a brief it writes a self-contained
 * single-file HTML/JS demo, TESTS IT HEADLESSLY (run_demo), and iterates
 * fix → re-run until clean — before anything reaches the lesson.
 *
 * The final headless verification runs in `finish`: the delivered html must
 * have a clean run even when the model claims success or forgets the final
 * run_demo.
 */

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

export const DEMO_ROLE: JobRole<DemoInput, DemoResult, DemoRunState> = {
	kind: "demo",
	model: "demoBuilder",
	maxTurns: 24,
	instructions: INSTRUCTIONS,
	activity: "building demo",
	crashed: "the builder crashed",
	initialState: () => ({ kind: "demo", html: null, testedHtml: null, lastResult: null }),
	tools: ({ state, host }) => ({
		write_demo: {
			name: "write_demo",
			description:
				"Write the complete self-contained HTML document for the demo (overwrites any previous version). " +
				"Always follow with run_demo to test it headlessly.",
			parameters: writeDemoInput,
			executionMode: "sequential",
			execute: serverExecute("write_demo", writeDemoInput, async ({ html }) => {
				if (!html || html.trim().length === 0) return "ERROR: empty document — write the full HTML.";
				await state.update((next) => {
					next.html = html;
				});
				host.onActivity?.(`write_demo: ${(html.length / 1024).toFixed(1)} KB`);
				return `Saved (${html.length} bytes). Now call run_demo to test it — never deliver untested.`;
			}),
		},
		run_demo: {
			name: "run_demo",
			description:
				"Headlessly execute the current demo in a browser and report console errors, uncaught errors, and failed requests. " +
				"Optionally pass a probe expression to assert on page state.",
			parameters: runDemoInput,
			executionMode: "sequential",
			execute: serverExecute("run_demo", runDemoInput, async ({ probe }) => {
				const html = (await state.read()).html;
				if (!html) return "ERROR: nothing to run — call write_demo first.";
				const reason = host.headless.unavailableReason();
				if (reason) return `HEADLESS UNAVAILABLE: ${reason}`;
				let result: DemoRunResult;
				try {
					result = await host.headless.runDemo(html, probe ? { probe } : undefined);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					host.onActivity?.("run_demo: browser error");
					return `HEADLESS ERROR (retrying may help): ${msg}`;
				}
				await state.update((next) => {
					next.testedHtml = html;
					next.lastResult = verification(result);
				});
				host.onActivity?.(result.ok ? "run_demo: clean" : `run_demo: ${summarizeCounts(result)}`);
				return formatRunResult(result);
			}),
		},
	}),
	input: (raw) => ({
		title: typeof raw?.title === "string" && raw.title.trim() ? raw.title.trim() : "Interactive demo",
		brief: typeof raw?.brief === "string" && raw.brief.trim() ? raw.brief.trim() : "(no brief)",
	}),
	precheck: async (_input, host) => host.headless.unavailableReason(),
	prompt: ({ title, brief }) =>
		[
			`Demo title: ${title}`,
			`Brief (all you know about the lesson — this comes from the teacher, verbatim):`,
			brief,
			"",
			"Build the demo, test it with run_demo, iterate until PASSED, then finish with your notes.",
		].join("\n"),
	async finish(input, { text, state }, host) {
		if (!state.html) {
			return DEMO_ROLE.failure(input, `the builder never wrote a demo.${text ? ` (${text.slice(0, 300)})` : ""}`);
		}
		if (state.testedHtml !== state.html || !state.lastResult?.ok) {
			host.onActivity?.("final verification");
			let verify: DemoRunResult;
			try {
				verify = await host.headless.runDemo(state.html);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return DEMO_ROLE.failure(input, `final verification crashed — ${msg}`);
			}
			if (!verify.ok) {
				return DEMO_ROLE.failure(
					input,
					`the demo never passed headless verification (${failureSummary(verification(verify))}).`,
				);
			}
		}
		return { title: input.title, html: state.html, tested: true, ...(text.trim() ? { notes: text.trim() } : {}) };
	},
	failure: (input, reason) => ({ title: input.title, html: "", tested: true, failure: reason }),
};
