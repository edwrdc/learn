import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { closeSvelteSsr, renderSvelte } from "./support-svelte-ssr.ts";

after(closeSvelteSsr);

async function render(text: string): Promise<string> {
	const { body } = await renderSvelte("/src/lib/markdown/Markdown.svelte", { text });
	return body;
}

describe("svelte markdown — math", () => {
	it("renders standard dollar math and keeps code literal", async () => {
		const html = await render("The symbol $\\Omega$ appears.\n\n$$\nS = k_B \\ln \\Omega\n$$\n\nUse `$x$` here.");
		assert.ok(html.includes("katex-display"));
		assert.ok(html.includes("Ω"));
		assert.ok(html.includes("$x$"), "inline code keeps its dollars");
	});
});

describe("svelte markdown — blocks", () => {
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
