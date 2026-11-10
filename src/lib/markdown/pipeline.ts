/**
 * THE MARKDOWN PIPELINE — one sanitized mdast→hast pass shared by SSR and
 * the browser:
 *   - remark-gfm + remark-breaks + the two CJK-friendly plugins (and the
 *     CJK link spacer) + remark-math with single-dollar text math;
 *   - legacy \(...\)/\[...\] delimiters are converted before parsing by
 *     src/tools/model/math-delims.ts (call sites), so both authoring dialects render;
 *   - raw HTML is parsed (rehype-raw), then sanitized with the GitHub
 *     schema (+ code metastring, + tel), then hardened with the configured
 *     options;
 *   - KaTeX runs AFTER sanitize (its output is generated, trusted markup);
 *     math nodes are carried as <lh-math tex display> so the Svelte
 *     renderer owns the KaTeX call and no raw unsanitized string is
 *     injected from the source.
 */

import { unified, type Plugin } from "unified";
import type { Code, Root as MdastRoot } from "mdast";
import type { Element, Root as HastRoot, RootContent } from "hast";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough";
import remarkRehype, { type Options as RemarkRehypeOptions } from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { harden } from "rehype-harden";
import { visit } from "unist-util-visit";

/** The CJK-adjacent punctuation whose placement must survive link parsing. */
const CJK_PUNCT = new Set([
	"\u3002", "\uFF0E", "\uFF0C", "\u3001", "\uFF1F", "\uFF01",
	"\uFF1A", "\uFF1B", "\uFF08", "\uFF09", "\u3010", "\u3011",
	"\u300C", "\u300D", "\u300E", "\u300F", "\u3008", "\u3009",
	"\u300A", "\u300B",
]);
const LINK_PREFIX = /^(https?:\/\/|mailto:|www\.)/i;

function firstPunct(text: string): number | null {
	let at = 0;
	for (const ch of text) {
		if (CJK_PUNCT.has(ch)) return at;
		at += ch.length;
	}
	return null;
}

/** Split an autolink at the first CJK punctuation so the URL part stays a
 *  link and the punctuation remains text (the cjk plugin's after-pass). */
const cjkLinkSpacer: Plugin<[], MdastRoot> = () => (tree) => {
	visit(tree, "link", (node, index, parent) => {
		if (!parent || typeof index !== "number") return;
		if (node.children.length !== 1) return;
		const only = node.children[0];
		if (only?.type !== "text" || only.value !== node.url || !LINK_PREFIX.test(node.url)) return;
		const cut = firstPunct(node.url);
		if (cut === null || cut === 0) return;
		parent.children.splice(
			index,
			1,
			{ ...node, url: node.url.slice(0, cut), children: [{ type: "text", value: node.url.slice(0, cut) }] },
			{ type: "text", value: node.url.slice(cut) },
		);
		return index + 1;
	});
};

/** Carry a fence's metastring (```js startLine=3) onto the <code> element. */
const codeMeta: Plugin<[], MdastRoot> = () => (tree) => {
	visit(tree, "code", (node: Code) => {
		if (!node.meta) return;
		node.data = node.data ?? {};
		node.data.hProperties = { ...(node.data.hProperties ?? {}), metastring: node.meta };
	});
};

/** House data attributes: the CSS hooks (globals.css) and render tests
 *  target these names. */
const houseAttributes: Plugin<[], HastRoot> = () => (tree) => {
	visit(tree, "element", (node: Element) => {
		if (node.properties.dataStreamdown !== undefined) return;
		switch (node.tagName) {
			case "li":
				node.properties.dataStreamdown = "list-item";
				break;
			case "thead":
				node.properties.dataStreamdown = "table-header";
				break;
			case "tbody":
				node.properties.dataStreamdown = "table-body";
				break;
			case "tr":
				node.properties.dataStreamdown = "table-row";
				break;
			case "th":
				node.properties.dataStreamdown = "table-header-cell";
				break;
			case "td":
				node.properties.dataStreamdown = "table-cell";
				break;
			case "blockquote":
				node.properties.dataStreamdown = "blockquote";
				break;
			case "strong":
				node.properties.dataStreamdown = "strong";
				break;
			case "code":
				node.properties.dataStreamdown = "inline-code";
				break;
			default:
				break;
		}
	});
};

/** Math nodes become a data-only element; KaTeX is called by the Svelte
 *  renderer (SSR included), never from escaped source HTML. */
const mathHandlers: RemarkRehypeOptions["handlers"] = {
	inlineMath: (_state, node) => ({
		type: "element",
		tagName: "lh-math",
		properties: { tex: (node as unknown as { value: string }).value, display: "false" },
		children: [],
	}),
	math: (_state, node) => ({
		type: "element",
		tagName: "lh-math",
		properties: { tex: (node as unknown as { value: string }).value, display: "true" },
		children: [],
	}),
};

type Schema = typeof defaultSchema;

const schema: Schema = {
	...defaultSchema,
	tagNames: [...(defaultSchema.tagNames ?? []), "lh-math"],
	attributes: {
		...defaultSchema.attributes,
		code: [...(defaultSchema.attributes?.code ?? []), "metastring"],
		"lh-math": ["tex", "display"],
	},
	protocols: {
		...defaultSchema.protocols,
		href: [...(defaultSchema.protocols?.href ?? []), "tel"],
	},
};

const hardenOptions = {
	allowedImagePrefixes: ["*"],
	allowedLinkPrefixes: ["*"],
	allowedProtocols: ["*"],
	defaultOrigin: undefined,
	allowDataImages: true,
};

const processor = unified()
	.use(remarkParse)
	.use(remarkGfm)
	.use(remarkMath, { singleDollarTextMath: true })
	.use(remarkCjkFriendly)
	.use(remarkCjkFriendlyGfmStrikethrough)
	.use(cjkLinkSpacer)
	.use(remarkBreaks)
	.use(codeMeta)
	.use(remarkRehype, { allowDangerousHtml: true, handlers: mathHandlers })
	.use(rehypeRaw)
	.use(rehypeSanitize, schema)
	.use(harden, hardenOptions)
	.use(houseAttributes)
	.freeze();

export function markdownToHast(markdown: string): HastRoot {
	return processor.runSync(processor.parse(markdown)) as HastRoot;
}

export function hastText(node: RootContent | Element | { type: string; value?: string; children?: unknown[] }): string {
	if (node.type === "text") return (node as { value: string }).value;
	const children = (node as { children?: unknown[] }).children;
	if (!Array.isArray(children)) return "";
	return children.map((child) => hastText(child as never)).join("");
}

export type { HastRoot };

/** Is the text still inside an unclosed ``` fence? (streaming skeleton
 *  decision; a crude line scan is enough — fences are line-anchored). */
export function hasOpenFence(markdown: string): boolean {
	let open = false;
	for (const line of markdown.split("\n")) {
		if (/^\s*```/.test(line)) open = !open;
	}
	return open;
}
