/** Svelte ports of the demo/visual artifact cards and the bridge. */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { buildAbortSteer, buildSubagentSteer } from "../src/jobs/model/types.ts";
import { projectView } from "../src/session/model/view.ts";
import { buildDemoSrcDoc, DEMO_BRIDGE_SCRIPT, INITIAL_DEMO_BRIDGE_STATE, reduceDemoBridgeState } from "../src/lib/artifacts/demo-bridge.ts";
import { slugFilename } from "../src/lib/artifacts/download.ts";
import { chartSize } from "../src/lib/markdown/mermaid.ts";
import { closeSvelteSsr, renderSvelte } from "./support-svelte-ssr.ts";

after(closeSvelteSsr);
const html = async (path: string, props: Record<string, unknown>) =>
	(await renderSvelte(path, props)).body.replace(/<!--[^>]*-->/g, "");

describe("demo bridge", () => {
	it("injects before </body> and appends otherwise", () => {
		const srcDoc = buildDemoSrcDoc('<!doctype html><html><body><canvas id="c"></canvas></body></html>');
		assert.match(srcDoc, /demo-resize/);
		assert.match(srcDoc, /demo-error/);
		assert.match(srcDoc, /ResizeObserver/);
		assert.match(srcDoc, /window\.addEventListener\("error"/);
		assert.ok(srcDoc.indexOf("ResizeObserver") < srcDoc.indexOf("</body>"));
		assert.match(srcDoc, /<canvas id="c">/);
		const fragment = buildDemoSrcDoc("<div>fragment demo</div>");
		assert.ok(fragment.endsWith("</script>"));
		assert.match(fragment, /fragment demo/);
	});

	it("reduces resize, error and garbage with clamps and identity", () => {
		let state = INITIAL_DEMO_BRIDGE_STATE;
		state = reduceDemoBridgeState(state, { type: "demo-resize", height: 421.7 });
		assert.equal(state.height, 422);
		assert.equal(state.error, null);
		state = reduceDemoBridgeState(state, { type: "demo-resize", height: 99999 });
		assert.equal(state.height, 2400);
		state = reduceDemoBridgeState(state, { type: "demo-resize", height: 5 });
		assert.equal(state.height, 80);
		assert.equal(reduceDemoBridgeState(state, { type: "demo-resize", height: "tall" }).height, 80);
		assert.equal(reduceDemoBridgeState(state, { type: "demo-resize" }).height, 80);
		state = reduceDemoBridgeState(state, { type: "demo-error", message: "x is not defined" });
		assert.equal(state.error, "x is not defined");
		assert.equal(state.height, 80);
		state = reduceDemoBridgeState(state, { type: "demo-error" });
		assert.equal(state.error, "unknown error");
		assert.deepEqual(reduceDemoBridgeState(state, { type: "something-else" }), state);
		assert.deepEqual(reduceDemoBridgeState(state, "demo-resize"), state);
		assert.deepEqual(reduceDemoBridgeState(state, null), state);
	});

	it("measures the body, not the viewport-clamped documentElement", () => {
		assert.ok(DEMO_BRIDGE_SCRIPT.includes("Math.max(b.scrollHeight,b.getBoundingClientRect().height)"));
		assert.ok(DEMO_BRIDGE_SCRIPT.includes("getComputedStyle(b)"));
	});
});

describe("demo output card", () => {
	const DEMO_HTML = "<!doctype html><html><body><h1>oscillator</h1></body></html>";
	const output = { title: "Damped oscillator", html: DEMO_HTML, tested: true };

	it("sandboxed iframe (allow-scripts only), bridge injected, invert + download chrome", async () => {
		const body = await html("/src/lib/artifacts/DemoOutputCard.svelte", { output });
		assert.match(body, /sandbox="allow-scripts"/);
		assert.ok(!body.includes("allow-same-origin"));
		assert.match(body, /demo-resize/);
		assert.match(body, /demo-error/);
		assert.match(body, /Damped oscillator/);
		assert.match(body, /interactive demo/);
		assert.match(body, /data-testid="demo-download"/);
		assert.match(body, /Invert demo brightness/);
		assert.match(body, /scrolling="no"/);
		assert.ok(!body.includes("hue-rotate"));
	});

	it("a failed build renders the note with no iframe", async () => {
		const body = await html("/src/lib/artifacts/DemoOutputCard.svelte", { output: { title: "T", html: "", tested: true, failure: "never passed verification" } });
		assert.match(body, /never passed verification/);
		assert.ok(!body.includes("<iframe"));
	});

	it("a missing/garbage result renders the quiet fallback", async () => {
		const body = await html("/src/lib/artifacts/DemoOutputCard.svelte", { output: { title: "T" } });
		assert.match(body, /could not be displayed/);
	});
});

describe("visual output card", () => {
	const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><circle cx="50" cy="50" r="20"/></svg>';

	it("renders the SVG image, figure caption below and invert/download", async () => {
		const body = await html("/src/lib/artifacts/VisualOutputCard.svelte", { output: { svg } });
		assert.ok(body.includes(encodeURIComponent(svg)));
		assert.ok(body.includes('data-testid="visual-card"'));
		assert.ok(body.includes('data-testid="visual-svg"'));
		const svgAt = body.indexOf('data-testid="visual-svg"');
		const captionAt = body.indexOf(">Figure<");
		assert.ok(svgAt !== -1 && captionAt !== -1 && svgAt < captionAt);
		assert.match(body, /data-testid="visual-download"/);
		assert.match(body, /Invert figure brightness/);
		assert.ok(!body.includes('data-testid="visual-open"'), "fullscreen needs the session overlay context");
		assert.ok(!body.includes("hue-rotate"));
	});

	it("a failed build renders the failed note with no svg", async () => {
		const body = await html("/src/lib/artifacts/VisualOutputCard.svelte", { output: { svg: "", failure: "iteration limit" } });
		assert.match(body, /iteration limit/);
		assert.ok(!body.includes("<svg"));
	});

	it("does not render the maker's notes on success", async () => {
		const body = await html("/src/lib/artifacts/VisualOutputCard.svelte", { output: { svg, notes: "Looking at the render, the diagram is clean." } });
		assert.ok(!body.includes("Looking at the render"));
	});

	it("slugFilename and chartSize keep their contracts", () => {
		assert.equal(slugFilename("Damped oscillator"), "damped-oscillator");
		assert.equal(slugFilename("Ünïcode — Tïtle!"), "unicode-title");
		assert.equal(slugFilename("???"), "demo");
		assert.deepEqual(chartSize('<svg width="320" height="240"></svg>'), { w: 320, h: 240 });
		assert.deepEqual(chartSize('<svg xmlns="x" width="50px" height="25px" viewBox="0 0 100 50"></svg>'), { w: 100, h: 50 });
	});
});

describe("dispatch card", () => {
	const job = (over: Record<string, unknown>) => ({
		id: "j1",
		kind: "research",
		chatId: "c1",
		toolCallId: "call-1",
		status: "running",
		activity: 'web_search: "plato"',
		createdAt: new Date(Date.now() - 5000).toISOString(),
		updatedAt: new Date().toISOString(),
		...over,
	});

	it("live activity, pending pulse, delivered, and failure states", async () => {
		const live = await html("/src/lib/artifacts/DispatchCard.svelte", { toolCallId: "call-1", kind: "research", jobs: [job({})] });
		assert.match(live, /Researcher/);
		assert.match(live, /web_search: (&quot;|")plato/);
		const pending = await html("/src/lib/artifacts/DispatchCard.svelte", { toolCallId: "call-1", kind: "research", jobs: [] });
		assert.match(pending, /Researcher/);
		assert.match(pending, /Dispatched…/);
		const done = await html("/src/lib/artifacts/DispatchCard.svelte", { toolCallId: "call-1", kind: "research", jobs: [job({ status: "done", activity: "delivered" })] });
		assert.match(done, /delivered/);
		assert.ok(!done.includes("web_search"));
		const failed = await html("/src/lib/artifacts/DispatchCard.svelte", { toolCallId: "call-1", kind: "research", jobs: [job({ status: "error", error: "boom" })] });
		assert.match(failed, /failed/);
	});

	it("refusals read as info with setup links, never the red failure", async () => {
		const models = await html("/src/lib/artifacts/DispatchCard.svelte", { toolCallId: "call-1", kind: "research", jobs: [job({ status: "error", error: "No model configured — set up your models first (missing: cheap)", refusal: "models_not_configured" })] });
		assert.ok(models.includes('data-testid="dispatch-refused"'));
		assert.match(models, /needs model setup/);
		assert.ok(!models.includes("failed"));
		const keys = await html("/src/lib/artifacts/DispatchCard.svelte", { toolCallId: "call-1", kind: "research", jobs: [job({ status: "error", error: "No OpenRouter key is set — add one in Settings → Keys", refusal: "provider_key_missing" })] });
		assert.ok(keys.includes('data-testid="dispatch-refused"'));
		assert.match(keys, /needs a provider key/);
	});

	it("pdf jobs carry the PDF-reader label", async () => {
		const body = await html("/src/lib/artifacts/DispatchCard.svelte", { toolCallId: "call-1", kind: "pdf", jobs: [job({ kind: "pdf", activity: "pdf_render: 42-44 @150dpi" })] });
		assert.match(body, /PDF reader/);
		assert.match(body, /pdf_render/);
	});
});

describe("artifact part job wiring", () => {
	const job = (over: Record<string, unknown>) => ({
		id: "j1",
		kind: "research",
		chatId: "c1",
		toolCallId: "call-1",
		status: "done",
		activity: "delivered",
		createdAt: new Date(Date.now() - 5000).toISOString(),
		updatedAt: new Date().toISOString(),
		...over,
	});
	const render = (type: string, jobs: unknown[]) =>
		html("/src/lib/chat/ArtifactPart.svelte", { part: { type, toolCallId: "call-1", state: "output-available" }, jobs });

	it("forwards the job list so research and pdf cards settle and refuse", async () => {
		for (const [type, label] of [["tool-research", "Researcher"], ["tool-pdf", "PDF reader"]] as const) {
			const done = await render(type, [job({})]);
			assert.match(done, new RegExp(label));
			assert.match(done, /delivered/);
			assert.ok(!done.includes("Dispatched"), `${type} rendered the pending card over a settled job`);

			const models = await render(type, [job({ status: "error", error: "No model configured — set up your models first (missing: cheap)", refusal: "models_not_configured" })]);
			assert.ok(models.includes('data-testid="dispatch-refused"'), `${type} rendered the refusal as a settled card`);
			assert.match(models, /needs model setup/);
			assert.ok(!models.includes("failed"), `${type} rendered the model refusal as a failure`);
		}
	});

	it("every job tool shows its card at dispatch, before the tool returns", async () => {
		for (const type of ["tool-research", "tool-pdf", "tool-demo", "tool-visual"]) {
			const body = await html("/src/lib/chat/ArtifactPart.svelte", { part: { type, toolCallId: "call-1", state: "input-available" }, jobs: [] });
			assert.ok(body.includes("Dispatched…"), `${type} rendered nothing while dispatching`);
		}
	});
});

describe("steer cards", () => {
	const view = (steer: unknown) => projectView([steer as never])[0]!;
	const render = (steer: unknown) => html("/src/lib/artifacts/SteerCard.svelte", { message: view(steer) });

	it("research complete is a quiet collapsed details with the brief and sources", async () => {
		const body = await render(buildSubagentSteer({ id: "jr", kind: "research", toolCallId: "cr" }, {
			brief: "Plato founded the Academy, a very long brief that would clutter the transcript.",
			sources: [{ title: "Britannica", url: "https://britannica.com/plato" }, { title: "IEP", url: "https://iep.utm.edu/plato/" }],
		}));
		assert.match(body, /Research/);
		assert.match(body, /complete/);
		assert.match(body, /2 sources/);
		assert.match(body, /view brief/);
		assert.match(body, /data-testid="research-complete-badge"/);
		assert.ok(!/<details[^>]*open/.test(body));
		assert.ok(body.includes("founded the Academy"));
		assert.ok(body.includes("britannica.com/plato"));
	});

	it("pdf complete counts read pages and keeps the path/question hidden", async () => {
		const body = await render(buildSubagentSteer({ id: "jpf", kind: "pdf", toolCallId: "cpf" }, {
			path: "/Users/x/course/chapter-3.pdf",
			question: "What is the integral?",
			brief: "The power rule appears on page 1.",
			pagesRead: [1],
			pagesConsulted: [1, 2],
		}));
		assert.match(body, /PDF/);
		assert.match(body, /reading complete/);
		assert.match(body, /read 1 page/);
		assert.match(body, /data-testid="pdf-complete-badge"/);
		assert.ok(!/<details[^>]*open/.test(body));
		assert.ok(body.includes("power rule"));
		assert.ok(!body.includes("/Users/x/course/chapter-3.pdf"));
	});

	it("pdf failure shows the failed brief", async () => {
		const body = await render(buildSubagentSteer({ id: "jpf2", kind: "pdf", toolCallId: "cpf2" }, { path: "/tmp/doc.pdf", question: "q", brief: "", failure: "the file could not be opened", pagesRead: [], pagesConsulted: [] }));
		assert.match(body, /pdf-brief-card/);
		assert.match(body, /failed/);
		assert.match(body, /could not be opened/);
		assert.ok(!body.includes("pdf-complete-badge"));
	});

	it("aborted jobs show the quiet badge without protocol glue", async () => {
		const body = await render(buildAbortSteer({ id: "jc", kind: "research", toolCallId: "cc" }));
		assert.match(body, /job-aborted-badge/);
		assert.match(body, /research/);
		assert.match(body, /aborted by the learner/);
		assert.ok(!body.includes("no brief is coming"));
	});

	it("visual success renders the SVG image and hides the maker notes; failure shows the note", async () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><circle cx="50" cy="50" r="20"/></svg>';
		const success = await render(buildSubagentSteer({ id: "jv", kind: "visual", toolCallId: "cv" }, { svg, notes: "Looking at the render, the diagram is clean." }));
		assert.ok(success.includes(encodeURIComponent(svg)) || success.includes("data:image/svg+xml"));
		assert.ok(!success.includes("Looking at the render"));
		const failure = await render(buildSubagentSteer({ id: "jv2", kind: "visual", toolCallId: "cv2" }, { svg: "", failure: "iteration limit" }));
		assert.match(failure, /iteration limit/);
		assert.ok(!failure.includes("<svg"));
	});

	it("a missing artifact renders the fallback note", async () => {
		const message = { id: "s", role: "user", parts: [{ type: "text", text: "x" }], metadata: { subagentResult: { jobId: "j", kind: "research", toolCallId: "c" } } };
		assert.match(await html("/src/lib/artifacts/SteerCard.svelte", { message }), /could not be displayed/);
	});
});
