/** Svelte ports of the question/answered/probe/practice card contracts. */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { buildAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/session/model/questions.ts";
import { practiceMetaRows, hasPracticeMeta } from "../src/lib/chat/practice-meta.ts";
import { closeSvelteSsr, renderSvelte } from "./support-svelte-ssr.ts";

after(closeSvelteSsr);
const html = async (path: string, props: Record<string, unknown>) =>
	(await renderSvelte(path, props)).body.replace(/<!--[^>]*-->/g, "");

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

const dock = (over: Record<string, unknown> = {}) =>
	html("/src/lib/chat/QuestionDock.svelte", {
		toolName: "quiz",
		toolCallId: "q1",
		input: quizInput,
		expanded: true,
		onExpand: () => {},
		onSubmit: () => {},
		...over,
	});

describe("question dock", () => {
	it("quiz form: options, IDK, thinking field, chord, never the answer", async () => {
		const body = await dock();
		assert.match(body, /Which planet is closest to the sun\?/);
		assert.match(body, /I don't know/);
		assert.ok(body.includes('data-testid="thinking-field"'));
		assert.match(body, /YOUR THINKING/);
		assert.match(body, /Why this answer\? Whatever comes to mind/);
		assert.match(body, /Submit answer/);
		assert.match(body, /↵ submits · ⇧↵ newline/);
		assert.ok(!body.includes('type="radio"'));
		assert.ok(body.includes('role="radio"'));
		assert.ok(!body.includes("innermost"));
	});

	it("ask: editable Other row, thinking field, no IDK or grading", async () => {
		const body = await dock({ toolName: "ask_user_question", input: { question: "How confident are you?", options: [{ label: "Very" }, { label: "Somewhat" }] } });
		assert.ok(!body.includes("I don't know"));
		assert.ok(body.includes('data-testid="other-option"'));
		assert.match(body, /Type your own answer/);
		assert.ok(body.includes('role="radio"'));
		assert.ok(body.includes("think"));
	});

	it("multi-select ask: select-all hint, checkbox rows incl. Other", async () => {
		const body = await dock({
			toolName: "ask_user_question",
			input: { question: "Which topics?", multiSelect: true, options: [{ label: "Physics" }, { label: "Philosophy" }] },
		});
		assert.match(body, /select all that apply/);
		assert.ok(body.includes('role="group"'));
		assert.ok((body.match(/role="checkbox"/g) ?? []).length >= 3);
		assert.ok(body.includes('data-testid="other-option"'));
	});

	it("text-mode ask keeps Enter-to-submit and the answer label only", async () => {
		const body = await dock({ toolName: "ask_user_question", input: { question: "Explain the chain rule." } });
		assert.ok(body.includes('data-testid="answer-field"'));
		assert.match(body, /Your answer/);
		assert.ok(!body.includes('data-testid="thinking-field"'));
	});

	it("malformed input renders the quiet fallback", async () => {
		const body = await dock({ input: { question: "q?", options: JSON.stringify([{ label: "a" }]) } });
		assert.ok(body.includes('data-testid="malformed-question"'));
		assert.match(body, /malformed/);
	});

	it("phase scales the thinking field: teach generous, probe compact", async () => {
		const teach = await dock({ phase: "teach" });
		assert.ok(teach.includes("min-h-[4.5rem]"));
		const probe = await dock();
		assert.ok(!probe.includes("min-h-[4.5rem]"));
		assert.ok(probe.includes("min-h-10"));
	});

	it("teach reveal invites; probe collapsed gets the plain Answer bar", async () => {
		const invitation = await dock({ toolCallId: "t1", expanded: false, reveal: true });
		assert.ok(invitation.includes('data-testid="teach-check-reveal"'));
		assert.match(invitation, /Check your understanding/);
		assert.match(invitation, /Which planet is closest/);
		assert.match(invitation, /Open/);
		const probe = await dock({ toolCallId: "q1", expanded: false });
		assert.ok(probe.includes('data-testid="question-dock-bar"'));
		assert.ok(!probe.includes("Check your understanding"));
		assert.match(probe, /Answer/);
	});

	it("probe and recall carry their own labels", async () => {
		assert.match(await dock({ toolName: "probe", toolCallId: "p1" }), /Probe/);
		const recall = await dock({ toolName: "recall", toolCallId: "r1", input: { question: "Explain the chain rule.", correctAnswer: "outer" } });
		assert.match(recall, /Recall/);
		assert.ok(!recall.includes(">Explain<"));
	});

	it("quiz math renders in question and options", async () => {
		const body = await dock({
			toolCallId: "m1",
			input: { question: "What is $\\frac{dy}{dx}$ of $y = x^2$?", options: [{ label: "$2x$" }, { label: "$x^2$" }], correctAnswer: "$2x$", explanation: "The power rule." },
		});
		assert.ok(body.includes("katex"));
	});
});

describe("answered card", () => {
	it("grades quiz answers, tucks the explanation, shows both glyph marks and confidence", async () => {
		const answer = buildAnswer(quizData(), { values: [normalizeOptions(quizInput.options)[0]!.value], thinking: "Brightest.", confidence: 70 }, "quiz");
		const body = await html("/src/lib/chat/AnsweredCard.svelte", { answer, input: quizInput });
		assert.match(body, /incorrect/);
		assert.ok(body.includes('data-testid="tucked-explanation"'));
		assert.ok(!body.includes("innermost"));
		assert.ok(body.includes('data-mark="check"') && body.includes('data-mark="x"'));
		assert.ok(body.includes('data-testid="answered-confidence"'));
		assert.match(body, /70%/);
		assert.ok(!body.includes('type="range"'));
	});

	it("thinking arrives collapsed above the explanation", async () => {
		const answer = buildAnswer(quizData(), { values: [normalizeOptions(quizInput.options)[0]!.value], thinking: "I picked Venus because it looks brightest." }, "quiz");
		const body = await html("/src/lib/chat/AnsweredCard.svelte", { answer, input: quizInput });
		assert.ok(body.includes('data-testid="your-thinking"'));
		assert.ok(body.includes('data-testid="your-thinking-trigger"'));
		assert.ok(body.includes('aria-expanded="false"'));
		assert.ok(!body.includes("brightest."));
		assert.ok(body.indexOf("your-thinking") < body.indexOf("tucked-explanation"));
	});

	it("hides confidence on IDK and ask answers", async () => {
		const idk = buildAnswer(quizData(), { values: [], dontKnow: true }, "quiz");
		assert.ok(!(await html("/src/lib/chat/AnsweredCard.svelte", { answer: idk })).includes("answered-confidence"));
		const askData: QuestionData = { id: "a1", kind: "ask", question: "How confident are you?", mode: "single-select", options: normalizeOptions([{ label: "Very" }, { label: "Somewhat" }]), createdAt: new Date().toISOString() };
		const ask = buildAnswer(askData, { values: ["Somewhat"] }, "ask_user_question");
		assert.ok(!(await html("/src/lib/chat/AnsweredCard.svelte", { answer: ask })).includes("answered-confidence"));
	});

	it("ask Other renders as an option row; ask answers are never graded", async () => {
		const askData: QuestionData = { id: "a1", kind: "ask", question: "How confident are you?", mode: "single-select", options: normalizeOptions([{ label: "Very" }, { label: "Somewhat" }]), createdAt: new Date().toISOString() };
		const answer = buildAnswer(askData, { other: "Fairly confident — but shaky on applications" }, "ask_user_question");
		const body = await html("/src/lib/chat/AnsweredCard.svelte", { answer });
		assert.ok(body.includes('data-testid="answered-other"'));
		assert.match(body, /border-primary bg-accent/);
		assert.match(body, /shaky on applications/);
		assert.ok(body.indexOf("Very") < body.indexOf("answered-other"));
		assert.ok(!body.includes("incorrect") && !body.includes('data-mark="x"'));
	});

	it("renders the text answer as Markdown, without decorative quotes", async () => {
		const askData: QuestionData = { id: "a2", kind: "ask", question: "How does the gradient behave?", mode: "text", options: [], createdAt: new Date().toISOString() };
		const answer = buildAnswer(askData, { text: "It points uphill.\n\n```py\nprint(1)\n```\n\nUse `grad(f)`." }, "ask_user_question");
		const body = await html("/src/lib/chat/AnsweredCard.svelte", { answer });
		assert.ok(body.includes('data-testid="md-code"'), "the fenced answer code renders as a block");
		assert.ok(body.includes('data-streamdown="inline-code"'), "the inline answer code renders");
		assert.ok(!body.includes("“"), "the answer carries no decorative quotes");
	});

	it("expanded thinking renders code and math with house typography, never italic", async () => {
		const body = await html("/src/lib/chat/ThinkingBlock.svelte", { text: "try `x=1` and $x^2$", defaultOpen: true });
		assert.ok(body.includes('data-streamdown="inline-code"'), "thinking inline code renders");
		assert.ok(body.includes("katex"), "thinking math renders");
		assert.ok(!body.includes("italic"), "thinking prose, code and math are never italic");
		assert.ok(body.includes("text-foreground/50"), "the muted thinking treatment stays");
	});

	it("explain reveals one committed answer with no verdict marks", async () => {
		const explain: QuestionData = {
			id: "e1",
			kind: "explain",
			question: "Explain why the null result matters.",
			mode: "text",
			options: [],
			committedAnswer: "It ruled out the luminiferous aether — a stationary aether predicts a fringe shift, and none was seen.",
			createdAt: new Date().toISOString(),
		};
		const body = await html("/src/lib/chat/AnsweredCard.svelte", { answer: buildAnswer(explain, { text: "Something about relativity?" }) });
		assert.match(body, /Explain/);
		assert.match(body, /The answer:/);
		assert.match(body, /luminiferous aether/);
		assert.ok(!body.includes("Why:"));
		assert.ok(!body.includes('data-mark="x"'));
		assert.match(body, /Something about relativity\?/);
	});

	it("dismissal renders skipped", async () => {
		const answer = { ...buildAnswer(quizData(), { dontKnow: true }, "quiz"), dismissed: true };
		assert.match(await html("/src/lib/chat/AnsweredCard.svelte", { answer }), /skipped/);
	});
});

describe("probe-done card", () => {
	const assessment = {
		strands: [
			{ strand: "modal logic basics", assessment: "Floor: solid intuition; ceiling: notation." },
			{ strand: "indexical 'actual'", assessment: "Genuine floor — prior exposure likely." },
		],
		summary: "Bracketed: teach the symbols on the intuition he has.",
	};

	it("renders strand assessment from a pending or output input", async () => {
		for (const state of ["input-available", "output-available"] as const) {
			const body = await html("/src/lib/artifacts/ProbeDoneCard.svelte", { part: { state, input: { assessment }, ...(state === "output-available" ? { output: { ok: true } } : {}) } });
			assert.ok(body.includes('data-testid="probe-done-card"'));
			assert.match(body, /modal logic basics/);
			assert.match(body, /Bracketed/);
		}
	});

	it("an output-only echo renders the quiet writing fallback", async () => {
		const body = await html("/src/lib/artifacts/ProbeDoneCard.svelte", { part: { state: "output-available", output: { ok: true } } });
		assert.match(body, /Writing the assessment/);
		assert.ok(!body.includes("modal logic basics"));
	});

	it("a rejected stringified assessment renders the retry note, not the garbage", async () => {
		const body = await html("/src/lib/artifacts/ProbeDoneCard.svelte", {
			part: { state: "output-error", errorText: "Validation failed", input: { assessment: 'strands: [{"strand": ...garbage' } },
		});
		assert.match(body, /malformed/);
		assert.match(body, /retried/);
		assert.ok(!body.includes("strands:"));
	});

	it("a partial input without strands renders the writing note", async () => {
		const body = await html("/src/lib/artifacts/ProbeDoneCard.svelte", { part: { state: "input-streaming", input: { assessment: { summary: "…" } } } });
		assert.match(body, /Writing the assessment/);
	});
});

describe("practice surface", () => {
	const part = (over: Record<string, unknown>) => ({ type: "tool-problem", state: "input-available", toolCallId: "call_p1", ...over });

	it("expanded dock: statement, Problem eyebrow, thinking field, one disabled submit lane", async () => {
		const body = await html("/src/lib/chat/PracticeDock.svelte", { problemCallId: "call_p1", input: { statement: "Show that the sum is even." }, expanded: true, onExpand: () => {}, onSubmit: () => {} });
		assert.ok(body.includes('data-testid="practice-dock"'));
		assert.match(body, /Show that the sum is even\./);
		assert.match(body, /Problem/);
		assert.match(body, /--dock-max-h/);
		assert.match(body, /YOUR THINKING/);
		assert.ok(body.includes('data-testid="practice-send"'));
		assert.ok(body.includes("disabled"));
		assert.ok(!body.includes("practice-nudge") && !body.includes("practice-commit"));
	});

	it("collapsed bar keeps the statement excerpt", async () => {
		const body = await html("/src/lib/chat/PracticeDock.svelte", { problemCallId: "call_p1", input: { statement: "Show that the sum is even." }, expanded: false, onExpand: () => {}, onSubmit: () => {} });
		assert.ok(body.includes('data-testid="practice-dock-bar"'));
		assert.match(body, /Show that the sum is even\./);
	});

	it("problem card is always open and never shows the commitment", async () => {
		const body = await html("/src/lib/chat/PracticeCards.svelte", { part: part({ input: { statement: "Prove the parity claim.", mode: "recall", modelSolution: "Pair them." } }) });
		assert.ok(body.includes('data-testid="problem-card"'));
		assert.match(body, /Problem/);
		assert.match(body, /Prove the parity claim\./);
		assert.doesNotMatch(body, /Pair them\./);
		assert.doesNotMatch(body, /<button/);
	});

	it("conclude card leads with the verdict, then the labeled solution, never the commitment in the problem", async () => {
		const body = await html("/src/lib/chat/PracticeCards.svelte", {
			part: part({ type: "tool-conclude", input: { outcome: "solvedWithHints", verdict: "The pairing came after R2." }, reveal: "Pair them; each pair is even." }),
		});
		assert.ok(body.includes('data-testid="conclude-card"'));
		assert.match(body, /Solved with hints/);
		assert.match(body, /Model solution/);
		assert.match(body, /The pairing came after R2\./);
		assert.match(body, /Pair them; each pair is even\./);
		assert.ok(body.indexOf("The pairing came after R2.") < body.indexOf("Pair them; each pair is even."));
	});

	it("legacy records fall back to solutionReveal; dismissed is one muted line", async () => {
		assert.match(await html("/src/lib/chat/PracticeCards.svelte", { part: part({ type: "tool-conclude", input: { outcome: "solved", solutionReveal: "Pair them." } }) }), /Pair them\./);
		const dismissed = await html("/src/lib/chat/PracticeCards.svelte", { part: part({ type: "tool-conclude", input: { outcome: "dismissed" } }) });
		assert.match(dismissed, /Problem dismissed\./);
		assert.doesNotMatch(dismissed, /The solution/);
	});

	it("metadata trigger appears only when fields were filled; rows are the small register", async () => {
		const withMeta = await html("/src/lib/chat/PracticeCards.svelte", {
			part: part({
				type: "tool-conclude",
				input: { outcome: "solvedWithHints", verdict: "v", rung: "R2", missClass: "cue", retest: true },
				problemInput: { mode: "discrimination", target: ["n_abc"] },
				reveal: "The solution.",
			}),
		});
		assert.ok(withMeta.includes('data-testid="metadata-toggle"'));
		assert.match(withMeta, /Metadata/);
		assert.ok(!withMeta.includes('data-testid="metadata-box"'));
		const bare = await html("/src/lib/chat/PracticeCards.svelte", { part: part({ type: "tool-conclude", input: { outcome: "solved" }, reveal: "s" }) });
		assert.ok(!bare.includes("metadata-"));
		const rows = practiceMetaRows({ conclude: { outcome: "solvedWithHints", rung: "R2", missClass: "cue", retest: true }, problem: { mode: "discrimination", target: ["n_abc"] }, names: { n_abc: "Parity" } });
		assert.deepEqual(rows, [
			{ label: "Mode", value: "discrimination" },
			{ label: "Targets", value: "Parity" },
			{ label: "Outcome", value: "solvedWithHints" },
			{ label: "Hint rung", value: "R2" },
			{ label: "Miss class", value: "cue" },
			{ label: "Retest", value: "yes" },
		]);
		assert.equal(hasPracticeMeta({ conclude: {}, problem: {} }), false);
		assert.equal(hasPracticeMeta({ conclude: { retest: false }, problem: {} }), true);
	});

	it("thinking card arrives expanded with the card band and rail", async () => {
		const body = await html("/src/lib/chat/ThinkingBlock.svelte", { testId: "thinking-card", label: "YOUR THINKING", text: "stuck at step two", defaultOpen: true });
		assert.match(body, /YOUR THINKING/);
		assert.ok(body.includes("stuck at step two"));
		assert.ok(body.includes('aria-expanded="true"'));
		assert.ok(body.includes("bg-card"));
		assert.ok(body.includes("border-l-[calc(3ch-14px)]"));
	});

	it("graph context collapses to counts and hides statements", async () => {
		const data = { propositions: [{ id: "n1", name: "Modus ponens", statement: "If P implies Q and P holds, Q holds." }], chains: ["Modus ponens → Soundness"] };
		const body = await html("/src/lib/chat/GraphContextCard.svelte", { data });
		assert.ok(body.includes('data-testid="graph-context-card"'));
		assert.ok(body.includes("1 proposition"));
		assert.ok(body.includes("1 chain"));
		assert.ok(!body.includes("If P implies Q"));
		assert.ok(!body.includes("graph-context-body"));
	});
});
