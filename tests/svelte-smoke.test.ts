import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { closeSvelteSsr, renderSvelte } from "./support-svelte-ssr.ts";

after(closeSvelteSsr);

describe("svelte static render harness", () => {
	it("renders markdown with KaTeX, tables and code fences", async () => {
		const { body } = await renderSvelte("/src/lib/markdown/Markdown.svelte", {
			text: "The map $f(x)=x^2$.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```",
		});
		assert.ok(body.includes("katex"));
		assert.ok(body.includes("data-streamdown=\"table\""));
		assert.ok(body.includes("data-streamdown=\"code-block\""));
	});
});
