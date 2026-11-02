/** Svelte ports of the rich-content contracts: markdown/math delimiters,
 *  house block chrome, tool-text recovery, mermaid fallback, and the
 *  source-vs-presentation boundary. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
	answerForPresentation,
	buildAnswer,
	normalizeOptions,
	parseAskInput,
	parseExplainInput,
	parseQuizInput,
	repairMathForDisplay,
	resolveCorrect,
	transformMathDelimiters,
	type QuestionData,
} from "../src/core/index.ts";
import { closeSvelteSsr, renderSvelte } from "./support-svelte-ssr.ts";

after(closeSvelteSsr);
const html = async (path: string, props: Record<string, unknown>) =>
	(await renderSvelte(path, props)).body.replace(/<!--[^>]*-->/g, "");
const md = (text: string, tool = false) => html("/src/lib/markdown/Markdown.svelte", { text, tool });
const dom = (body: string) => parseHTML(`<html><body>${body}</body></html>`).document;
const tex = (body: string) => [...dom(body).querySelectorAll('annotation[encoding="application/x-tex"]')].map((node) => node.textContent);

describe("math delimiters", () => {
	it("legacy \\(...\\) inline and \\[...\\] display", async () => {
		const inline = await md(String.raw`The map \(f(x)=x^2\) is smooth.`);
		assert.ok(inline.includes("katex"));
		assert.ok(!inline.includes("katex-display"));
		const display = await md("Posterior:\n\n\\[\nP(L_t=1 \\mid \\text{correct})\n\\]\n\nDone.");
		assert.ok(display.includes("katex-display"));
	});

	it("mid-paragraph display is hoisted without leaking dollars or errors", async () => {
		const body = await md("before \\[x^2\\] after");
		assert.ok(body.includes("katex-display"));
		assert.ok(!body.includes("$$"));
		assert.ok(!body.includes("katex-error"));
	});

	it("indented display math inside a list degrades to inline and keeps both items", async () => {
		const body = await md("- item one\n  \\[x^2\\]\n- item two");
		assert.ok(body.includes("katex"));
		assert.ok(body.includes("item two"));
		assert.equal((body.match(/data-streamdown="list-item"/g) ?? []).length, 2);
	});

	it("one-line $$...$$ is inline; fenced $$ is display", async () => {
		const one = await md("$$\\int_0^1 x^2\\,dx$$");
		assert.ok(one.includes("katex") && !one.includes("katex-display"));
		const fenced = await md("$$\nS = k_B \\ln \\Omega\n$$");
		assert.ok(fenced.includes("katex-display"));
		assert.ok(fenced.includes("Ω"));
	});

	it("escaped currency and code fences stay literal", async () => {
		const currency = await md("It costs \\$5 and \\$10 more.");
		assert.ok(!currency.includes("katex"));
		assert.match(currency, /\$5 and \$10/);
		const code = await md("```\n\\(x^2\\) stays literal\n```");
		assert.ok(!code.includes("katex"));
		assert.ok(code.includes("code-block"));
	});

	it("an unbalanced bracket mid-stream stays literal", async () => {
		const body = await md("partial \\[ mid-stream");
		assert.ok(!body.includes("katex") && !body.includes("$$"));
	});

	it("math renders inside headings and keeps the heading", async () => {
		const body = await md("## The map \\(f(x)\\)");
		assert.ok(body.includes("<h2"));
		assert.ok(body.includes("katex"));
	});

	it("transformMathDelimiters retains its pure contract", () => {
		assert.equal(transformMathDelimiters("a \\(x^2\\) b"), "a $$x^2$$ b");
		assert.equal(transformMathDelimiters("text\n\n\\[\n\\int x\n\\]\n\nmore"), "text\n\n$$\n\\int x\n$$\n\nmore");
		assert.equal(transformMathDelimiters("mid \\[x^2\\] para"), "mid \n\n$$\nx^2\n$$\n\n para");
		assert.equal(transformMathDelimiters("- item\n  \\[\n  x^2\n  \\]\n- next"), "- item\n  $$x^2$$\n- next");
		const currency = "It costs $5 and $10 more. $$big$$ sums too.";
		assert.equal(transformMathDelimiters(currency), currency);
		assert.equal(transformMathDelimiters("```js\n\\(x\\)\n```"), "```js\n\\(x\\)\n```");
		assert.equal(transformMathDelimiters("run `\\(x\\)` locally"), "run `\\(x\\)` locally");
		assert.equal(transformMathDelimiters("partial \\[ mid-stream"), "partial \\[ mid-stream");
	});
});

describe("house blocks", () => {
	it("GFM tables carry the copy corner and cell padding without streamdown's wrapper", async () => {
		const body = await md("| A | B |\n| --- | --- |\n| 1 | 2 |");
		assert.ok(body.includes('data-testid="md-table"'));
		assert.ok(body.includes('data-streamdown="table"'));
		assert.ok(!body.includes('data-streamdown="table-wrapper"'));
		assert.ok(body.includes('aria-label="Copy table"'));
		assert.ok(body.includes("px-4 py-2"));
		assert.match(body, /absolute top-1 right-1 z-10/);
	});

	it("code fences use the named md group and the hover copy corner", async () => {
		const body = await md("```js\nconst x = 1;\n```");
		assert.ok(body.includes('data-testid="md-code"'));
		assert.ok(body.includes('data-streamdown="code-block"'));
		assert.ok(body.includes('data-streamdown="code-block-body"'));
		assert.match(body, /aria-label="Copy code"/);
		assert.ok(body.includes("group/md"));
		assert.match(body, /group-hover\/md:opacity-100/);
		assert.ok(!body.includes('data-testid="md-copy-pill"'));
		assert.ok(body.includes("data-lh-line-numbers"));
	});

	it("display math gets a block wrapper and its own TeX copy corner", async () => {
		const body = await md("$$\n\\int_0^1 x^2\\,dx = \\tfrac{1}{3}\n$$");
		assert.ok(body.includes("katex-display"));
		assert.ok(body.includes('data-testid="md-math"'));
		assert.match(body, /aria-label="Copy equation source"/);
		assert.match(body, /group\/md relative block/);
		assert.match(body, /absolute top-0 right-0 z-10/);
	});

	it("mermaid is the app block, never a code block, source never leaks", async () => {
		const body = await md("```mermaid\ngraph TD\nA --> B\n```");
		assert.ok(body.includes('data-testid="md-mermaid"'));
		assert.ok(!body.includes('data-streamdown="code-block"'));
		assert.ok(!body.includes("graph TD"));
	});

	it("all five GitHub alert markers box identically; plain quotes do not", async () => {
		for (const kind of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) {
			const body = await md(`> [!${kind}]\n> Load-bearing words.`);
			assert.ok(body.includes('data-testid="md-callout"'));
			assert.ok(body.includes(`data-alert-kind="${kind.toLowerCase()}"`));
			assert.ok(!body.includes(`[!${kind}]`));
			assert.ok(body.includes("Load-bearing words."));
		}
		const plain = await md("> Just an ordinary quote.");
		assert.ok(!plain.includes('data-testid="md-callout"'));
	});

	it("single newlines break; lists stay lists; code blocks have no injected breaks", async () => {
		assert.match(await md("line one\nline two"), /<br\s*\/?>/);
		const list = await md("- alpha\n- beta");
		assert.equal((list.match(/data-streamdown="list-item"/g) ?? []).length, 2);
		assert.ok(!list.includes("<br"));
		assert.ok(!(await md("```js\nline one\nline two\n```")).includes("<br"));
	});
});

describe("mermaid error fallback", () => {
	it("shows the error, collapsed source and Retry", async () => {
		const body = await html("/src/lib/markdown/MermaidError.svelte", { chart: "not a diagram @@@\nA --> B", error: "Parse error on line 1", retry: () => {} });
		assert.ok(body.includes('data-streamdown="mermaid-error"'));
		assert.match(body, /Diagram failed to render/);
		assert.match(body, /Parse error on line 1/);
		assert.match(body, /Show diagram source/);
		assert.match(body, />Retry</);
	});
});

describe("tool-text recovery", () => {
	const cases = JSON.parse(readFileSync(new URL("./fixtures/tool-rendering/matrix-regressions.json", import.meta.url), "utf8")) as {
		cases: Array<{ chatId: string; source: string; raw: string; oldDisplay: string }>;
	};

	it("preserves corpus matrix rows exactly", async () => {
		for (const fixture of cases.cases) {
			assert.equal(repairMathForDisplay(fixture.raw), fixture.raw, fixture.chatId);
			const recovered = dom(await md(fixture.raw, true));
			const plain = dom(await md(fixture.raw));
			assert.deepEqual(
				[...recovered.querySelectorAll('annotation[encoding="application/x-tex"]')].map((node) => node.textContent),
				[...plain.querySelectorAll('annotation[encoding="application/x-tex"]')].map((node) => node.textContent),
				fixture.chatId,
			);
			assert.ok(recovered.querySelectorAll("mtr").length > 0, fixture.chatId);
			assert.equal(recovered.querySelectorAll(".katex-error").length, 0, fixture.chatId);
		}
	});

	it("recovers doubled command slashes and JSON debris for display only", async () => {
		const texSource = String.raw`\nabla f(x) \in \mathbb{R}^{m \times n}`;
		const doubled = `$${texSource}$`.replace(/\\/g, "\\\\");
		assert.equal(repairMathForDisplay(doubled), `$${texSource}$`);
		const debris = "$\forall x \\in \\mathbb{R}$";
		assert.equal(repairMathForDisplay(debris), String.raw`$\forall x \in \mathbb{R}$`);
		const body = await md(doubled, true);
		assert.deepEqual(tex(body), [texSource]);
		assert.equal(dom(body).querySelectorAll(".katex-error").length, 0);
	});

	it("shape parsers keep source bytes; recovery is presentation-only", () => {
		const doubled = String.raw`$\\nabla f$`;
		const quiz = { question: doubled, options: [{ label: doubled }, { label: "no" }], correctAnswer: doubled, explanation: "$\forall x$" };
		const ask = { question: doubled, options: [{ label: doubled, value: doubled, description: doubled }, { label: "no" }] };
		const explain = { question: doubled, correctAnswer: "$\forall x$" };
		const before = structuredClone({ quiz, ask, explain });
		assert.equal(parseQuizInput(quiz)!.question, doubled);
		assert.equal(parseQuizInput(quiz)!.correctAnswer, doubled);
		assert.deepEqual(parseAskInput(ask), ask);
		assert.deepEqual(parseExplainInput(explain), explain);
		assert.deepEqual({ quiz, ask, explain }, before);
	});

	it("a presentation-equivalent label cannot make a source-invalid correctAnswer gradeable", () => {
		const doubled = String.raw`$\\nabla f$`;
		const source = { question: "Which?", options: [{ label: String.raw`$\nabla f$` }, { label: "no" }], correctAnswer: doubled, explanation: "mismatch" };
		assert.equal(parseQuizInput(source), undefined);
	});

	it("answers snapshot source text and presentation joins restore matrices", () => {
		const a = String.raw`$\begin{pmatrix}a&b\\c&d\end{pmatrix}$`;
		const b = String.raw`$\begin{pmatrix}p&q\\r&s\end{pmatrix}$`;
		const input = { question: a, options: [{ label: a }, { label: b }], correctAnswer: a, explanation: a };
		const parsed = parseQuizInput(input)!;
		const options = normalizeOptions(parsed.options);
		const qd: QuestionData = { id: "s", kind: "quiz", question: parsed.question, mode: "single-select", options, correctIndices: resolveCorrect(parsed.correctAnswer, options).indices, explanation: parsed.explanation, createdAt: "synthetic" };
		const answer = buildAnswer(qd, { values: [a], confidence: 70 }, "probe");
		assert.equal(answer.questionText, a);
		assert.equal(answer.options![0]!.label, a);
		assert.equal(answer.answers[0]!.value, a);
		assert.equal(answer.explanation, a);
		assert.equal(answer.correct, true);
		const brokenA = a.replace(String.raw`\\c`, String.raw`\c`);
		const historical = { kind: "quiz", questionText: brokenA, options: [{ index: 1, label: b }, { index: 2, label: brokenA }], answers: [{ index: 1, label: b, value: "b" }], correct: false, correctIndices: [2], dontKnow: false, explanation: brokenA, confidence: 70, answeredAt: "synthetic" } as never;
		const projection = answerForPresentation(historical, input);
		assert.equal(projection.questionText, a);
		assert.equal(projection.explanation, a);
		assert.deepEqual(projection.options, [{ index: 1, label: b }, { index: 2, label: a }]);
		assert.equal(projection.correct, false);
	});
});
