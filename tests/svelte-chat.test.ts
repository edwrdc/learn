import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
	buildAnswer,
	normalizeOptions,
	resolveCorrect,
	type QuestionData,
} from "../src/core/index.ts";
import { closeSvelteSsr, renderSvelte } from "./support-svelte-ssr.ts";

after(closeSvelteSsr);

const strip = (html: string) => html.replace(/<!--[^>]*-->/g, "");
async function render(component: string, props: Record<string, unknown>): Promise<string> {
	return strip((await renderSvelte(component, props)).body);
}

const quizInput = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
};

function quizData(): QuestionData {
	const options = normalizeOptions(quizInput.options);
	return {
		id: "q1",
		kind: "quiz",
		question: quizInput.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(quizInput.correctAnswer, options).indices,
		explanation: quizInput.explanation,
		createdAt: new Date().toISOString(),
	};
}

const PLAN_TREE = {
	nodes: [
		{ id: "a", title: "Alpha" },
		{ id: "b", title: "Beta" },
	],
	edges: [{ from: "a", to: "b" }],
	version: 1,
};

const planMessages = [
	{ id: "m1", role: "user", parts: [] },
	{ id: "m2", role: "assistant", parts: [{ type: "tool-plan_init", state: "output-available", output: { ok: true, tree: PLAN_TREE } }] },
];

describe("svelte question dock", () => {
	it("renders the quiz form, thinking field and chord hint, never the answer", async () => {
		const html = await render("/src/lib/chat/QuestionDock.svelte", {
			toolName: "quiz",
			toolCallId: "q1",
			input: quizInput,
			expanded: true,
			onExpand: () => {},
			onSubmit: () => {},
		});
		assert.match(html, /Which planet is closest to the sun\?/);
		assert.match(html, /I don.t know/);
		assert.ok(html.includes('data-testid="thinking-field"'));
		assert.match(html, /YOUR THINKING/);
		assert.match(html, /Submit answer/);
		assert.match(html, /↵ submits · ⇧↵ newline/);
		assert.ok(html.includes('role="radio"'));
		assert.ok(!html.includes("Mercury is the innermost planet"), "explanation never leaks before submit");
	});

	it("renders the teach-check reveal invitation", async () => {
		const html = await render("/src/lib/chat/QuestionDock.svelte", {
			toolName: "quiz",
			toolCallId: "q1",
			input: quizInput,
			expanded: false,
			reveal: true,
			onExpand: () => {},
			onSubmit: () => {},
		});
		assert.ok(html.includes('data-testid="teach-check-reveal"'));
		assert.match(html, /Check your understanding/);
		assert.match(html, /Open/);
	});

	it("renders a malformed question as the quiet fallback", async () => {
		const html = await render("/src/lib/chat/QuestionDock.svelte", {
			toolName: "quiz",
			toolCallId: "q1",
			input: { nonsense: true },
			expanded: true,
			onExpand: () => {},
			onSubmit: () => {},
		});
		assert.ok(html.includes('data-testid="malformed-question"'));
		assert.match(html, /This question arrived malformed/);
	});
});

describe("svelte answered card", () => {
	it("grades a quiz answer with the correct chip, marks and explanation fold", async () => {
		const qd = quizData();
		const answer = buildAnswer(
			qd,
			{ dontKnow: false, values: [qd.options[1]!.value], thinking: "It is innermost.", confidence: 90 },
			"quiz",
		);
		const html = await render("/src/lib/chat/AnsweredCard.svelte", { answer, input: quizInput });
		assert.ok(html.includes('data-testid="answered-card"'));
		assert.match(html, /correct/);
		assert.ok(html.includes("Mercury"));
		assert.ok(html.includes('data-testid="tucked-explanation"'), "explanation is folded");
		assert.ok(!html.includes("Mercury is the innermost planet"), "the why text stays tucked");
		assert.ok(html.includes('data-testid="answered-confidence"'));
		assert.ok(html.includes('data-testid="your-thinking"'));
	});

	it("renders a skipped question as a muted record", async () => {
		const qd = quizData();
		const answer = buildAnswer(qd, { dontKnow: true, values: [], thinking: undefined, confidence: undefined }, "quiz");
		answer.dismissed = true;
		const html = await render("/src/lib/chat/AnsweredCard.svelte", { answer });
		assert.match(html, /skipped/);
	});
});

describe("svelte artifact cards", () => {
	it("dispatch refused jobs read as info, not errors", async () => {
		const jobs = [
			{
				id: "j1", kind: "research", chatId: "c1", toolCallId: "t1", status: "error",
				error: "No model configured — set up your models first (missing: cheap)",
				activity: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
			},
		];
		const html = await render("/src/lib/artifacts/DispatchCard.svelte", { toolCallId: "t1", kind: "research", jobs });
		assert.ok(html.includes('data-testid="dispatch-refused"'));
		assert.match(html, /needs model setup/);
		assert.ok(!html.includes("failed"));
	});

	it("probe_done renders the strand assessment", async () => {
		const html = await render("/src/lib/artifacts/ProbeDoneCard.svelte", {
			part: {
				state: "input-available",
				input: { assessment: { strands: [{ strand: "BKT", assessment: "solid recall" }], summary: "Ready to teach." } },
			},
		});
		assert.ok(html.includes('data-testid="probe-done-card"'));
		assert.match(html, /solid recall/);
		assert.match(html, /Ready to teach/);
	});
});

describe("svelte transcript chrome", () => {
	it("phase dividers and compaction dividers keep their labels", async () => {
		const plan = await render("/src/lib/chat/PhaseDivider.svelte", { phase: "plan", nodeCount: 4 });
		assert.ok(plan.includes('data-testid="phase-divider-plan"'));
		assert.match(plan, /Plan · 4 nodes/);
		const teach = await render("/src/lib/chat/PhaseDivider.svelte", { phase: "teach" });
		assert.match(teach, /Teaching/);
		const moment = await render("/src/lib/chat/CompactionDivider.svelte", {
			data: { content: "", details: { tokensBefore: 50541 } },
		});
		assert.match(moment, /Context compacted/);
		const cut = await render("/src/lib/chat/CompactionDivider.svelte", {
			data: { content: "", details: { tokensBefore: 50541 } },
			cut: true,
		});
		assert.match(cut, /History compacted · 51k tok/);
	});

	it("queued steers render one quiet truncated line each", async () => {
		const html = await render("/src/lib/chat/QueuedSteers.svelte", {
			steers: [{ id: "s1", text: "also explain the prior" }],
		});
		assert.ok(html.includes('data-testid="queued-steers"'));
		assert.match(html, /also explain the prior/);
	});

	it("plan marginalia renders the diagram; the popup is a session dialog", async () => {
		const marginalia = await render("/src/lib/chat/PlanMarginalia.svelte", { messages: planMessages });
		assert.match(marginalia, /aria-label="Plan diagram"/);
		assert.match(marginalia, /plan-node-a/);
		const popup = await render("/src/lib/chat/PlanPopup.svelte", { messages: planMessages, onClose: () => {} });
		assert.match(popup, /data-testid="plan-popup"/);
		assert.match(popup, /role="dialog"/);
		assert.match(popup, /aria-label="The full plan"/);
		assert.match(popup, /Drag to pan · scroll to zoom/);
	});
});

describe("svelte practice surface", () => {
	it("expanded practice dock renders the problem and one submit lane", async () => {
		const html = await render("/src/lib/chat/PracticeDock.svelte", {
			problemCallId: "p1",
			input: { statement: "Derive the posterior." },
			expanded: true,
			onExpand: () => {},
			onSubmit: () => {},
		});
		assert.ok(html.includes('data-testid="practice-dock"'));
		assert.match(html, /Derive the posterior/);
		assert.match(html, /YOUR THINKING/);
		assert.match(html, /Submit thinking/);
		assert.match(html, /↵ submits · ⇧↵ newline/);
	});

	it("collapsed practice bar keeps the statement as the teaser", async () => {
		const html = await render("/src/lib/chat/PracticeDock.svelte", {
			problemCallId: "p1",
			input: { statement: "Derive the posterior." },
			expanded: false,
			onExpand: () => {},
			onSubmit: () => {},
		});
		assert.ok(html.includes('data-testid="practice-dock-bar"'));
		assert.match(html, /Problem/);
	});
});
