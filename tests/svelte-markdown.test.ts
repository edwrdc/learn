import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { closeSvelteSsr, renderSvelte } from "./support-svelte-ssr.ts";

after(closeSvelteSsr);

async function render(text: string, tool = false): Promise<string> {
	const { body } = await renderSvelte("/src/lib/markdown/Markdown.svelte", { text, tool });
	return body;
}

describe("svelte markdown — math", () => {
	it("renders legacy \\(...\\) and \\[...\\] as KaTeX", async () => {
		const inline = await render(String.raw`The map \(f(x)=x^2\) is smooth.`);
		assert.match(inline, /class="katex/);
		assert.ok(!inline.includes("katex-display"), "parens math is inline");
		const display = await render("Posterior:\n\n\\[\nP(L_t=1 \\mid \\text{correct})\n\\]\n\nDone.");
		assert.ok(display.includes("katex-display"), "bracket math is display");
	});

	it("renders standard dollar math and keeps code literal", async () => {
		const html = await render("The symbol $\\Omega$ appears.\n\n$$\nS = k_B \\ln \\Omega\n$$\n\nUse `$x$` here.");
		assert.ok(html.includes("katex-display"));
		assert.ok(html.includes("Ω"));
		assert.ok(html.includes("$x$"), "inline code keeps its dollars");
	});

	it("repairs over-escaped tool math and keeps incomplete math literal", async () => {
		const tool = await render(String.raw`allowing forgetting means the row sums to \([0,1]\) unchanged.`, true);
		assert.ok(tool.includes("class=\"katex") || tool.includes("katex"), "tool text recovers delimiters");
		const incomplete = await render("partial \\[ mid-stream");
		assert.ok(!incomplete.includes("katex") && !incomplete.includes("$$"));
	});
});

describe("svelte markdown — blocks", () => {
	it("renders GFM tables with the copy corner and cell padding", async () => {
		const html = await render("| A | B |\n| --- | --- |\n| 1 | 2 |");
		assert.ok(html.includes('data-testid="md-table"'));
		assert.ok(html.includes('data-streamdown="table"'));
		assert.ok(html.includes('aria-label="Copy table"'));
		assert.ok(html.includes("px-4 py-2"), "cells carry the prose table padding");
	});

	it("renders code fences with line numbers + a copy affordance", async () => {
		const html = await render("```js\nconst x = 1;\n```");
		assert.ok(html.includes('data-testid="md-code"'));
		assert.ok(html.includes('data-streamdown="code-block-body"'));
		assert.ok(html.includes('aria-label="Copy code"'));
		assert.ok(html.includes("data-lh-line-numbers"));
	});

	it("renders mermaid as the app block, never a code block, source hidden", async () => {
		const html = await render("```mermaid\ngraph TD\nA --> B\n```");
		assert.ok(html.includes('data-testid="md-mermaid"'));
		assert.ok(!html.includes('data-streamdown="code-block"'));
		assert.ok(!html.includes("graph TD"), "chart source does not leak");
	});

	it("renders single newlines as breaks, lists as list items", async () => {
		const breaks = await render("line one\nline two");
		assert.match(breaks, /<br\s*\/?>/);
		const list = await render("- alpha\n- beta");
		assert.equal((list.match(/data-streamdown="list-item"/g) ?? []).length, 2);
	});

	it("boxes GitHub alert callouts and strips the marker", async () => {
		const html = await render("> [!IMPORTANT]\n> ALL X is done through Y.");
		assert.ok(html.includes('data-testid="md-callout"'));
		assert.ok(html.includes('data-alert-kind="important"'));
		assert.ok(html.includes("ALL X is done through Y."));
		assert.ok(!html.includes("[!IMPORTANT]"));
		assert.ok(html.includes("border-white") && html.includes("w-fit"));
	});

	it("sanitizes raw HTML and scripts", async () => {
		const html = (await render('<b>raw</b> <script>alert(1)</script><iframe src="https://evil.example"></iframe>')).replace(/<!--[^>]*-->/g, "");
		assert.ok(html.includes("<b>raw</b>"));
		assert.ok(!/<script/i.test(html));
		assert.ok(!/<iframe/i.test(html));
	});
});

describe("svelte markdown — KaTeX authority boundary", () => {
	const blocked = String.raw`\href{https://katex-security.invalid/blocked}{blocked}`;
	function withoutAuthority(html: string) {
		const { document } = parseHTML(html);
		assert.equal(document.querySelectorAll("[href], [src], a, img, script, iframe").length, 0);
		assert.ok(html.includes("blocked"), "the formula was processed");
	}
	it("ignores Object.prototype.trust inherited by KaTeX and the app renderer", async () => {
		const previous = Object.getOwnPropertyDescriptor(Object.prototype, "trust");
		try {
			Object.defineProperty(Object.prototype, "trust", { value: true, configurable: true, writable: true });
			const html = await render(`$${blocked}$`);
			withoutAuthority(html);
		} finally {
			if (previous) Object.defineProperty(Object.prototype, "trust", previous);
			else Reflect.deleteProperty(Object.prototype, "trust");
		}
	});
});
