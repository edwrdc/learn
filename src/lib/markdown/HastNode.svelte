<script lang="ts">
	import type { Element, ElementContent, RootContent } from "hast";
	import MathBlock from "./MathBlock.svelte";
	import CodeBlock from "./CodeBlock.svelte";
	import MermaidBlock from "./MermaidBlock.svelte";
	import CopyCorner from "./CopyCorner.svelte";
	import HastNode from "./HastNode.svelte";
	import { hastText, type HastRoot } from "./pipeline";

	let {
		node,
		incomplete = false,
	}: { node: RootContent | ElementContent | HastRoot; incomplete?: boolean } = $props();

	const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "source", "wbr", "col", "area", "base", "embed", "param", "track"]);
	const ATTR: Record<string, string> = {
		className: "class",
		htmlFor: "for",
		colSpan: "colspan",
		rowSpan: "rowspan",
	};

	function houseClass(el: Element): string | undefined {
		switch (el.tagName) {
			case "h1":
				return "mt-6 mb-4 font-semibold text-3xl";
			case "h2":
				return "mt-6 mb-2 font-semibold text-2xl";
			case "h3":
				return "mt-4 mb-2 font-semibold text-xl";
			case "h4":
			case "h5":
			case "h6":
				return "mt-4 mb-2 font-semibold text-lg";
			case "ul":
				return "list-inside list-disc whitespace-normal [li_&]:pl-6";
			case "ol":
				return "list-inside list-decimal whitespace-normal [li_&]:pl-6";
			case "li":
				return "py-1 [&>p]:inline";
			case "a":
				return "text-primary underline-offset-2 hover:underline";
			case "thead":
				return "bg-muted/80";
			case "tbody":
				return "divide-y divide-border";
			case "tr":
				return "border-border";
			case "th":
				return "whitespace-nowrap px-4 py-2 text-left font-semibold text-sm";
			case "td":
				return "px-4 py-2 text-sm";
			default:
				return undefined;
		}
	}

	function attrs(el: Element): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(el.properties ?? {})) {
			if (value === null || value === undefined || value === false) continue;
			const name = ATTR[key] ?? key;
			if (name === "metastring" || name === "dataStreamdown") {
				if (name === "dataStreamdown") out["data-streamdown"] = value;
				continue;
			}
			if (name === "checked" || name === "disabled") {
				out[name] = true;
				continue;
			}
			out[name] = Array.isArray(value) ? value.join(" ") : value;
		}
		const house = houseClass(el);
		if (house) out.class = out.class ? `${house} ${String(out.class)}` : house;
		return out;
	}

	function codeElement(pre: Element): Element | null {
		const child = pre.children.find((c) => c.type === "element" && c.tagName === "code");
		return (child as Element | undefined) ?? null;
	}

	function codeLang(code: Element | null): string {
		const cls = code?.properties.className as string | string[] | undefined;
		const list = Array.isArray(cls) ? cls : typeof cls === "string" ? cls.split(" ") : [];
		for (const name of list) {
			const match = /^language-(.+)$/.exec(String(name));
			if (match) return match[1]!;
		}
		return "";
	}

	function codeMeta(code: Element | null): string {
		const meta = code?.properties.metastring;
		return typeof meta === "string" ? meta : "";
	}

	const MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;
	const significant = (c: ElementContent | null | undefined) =>
		c !== null && c !== undefined && c.type !== "comment" && !(c.type === "text" && c.value.trim() === "");

	/** GitHub-alert blockquote: returns the kind and the children with the
	 *  marker line (and its hard-break) removed. */
	function parseAlert(children: ElementContent[]): { kind: string; children: ElementContent[] } | null {
		const para = children.find(significant);
		if (!para || para.type !== "element" || para.tagName !== "p") return null;
		const lead = para.children.find(significant);
		if (!lead || lead.type !== "text") return null;
		const match = MARKER.exec(lead.value);
		if (!match) return null;
		const stripped = lead.value.slice(match[0].length);
		let inner: Array<ElementContent | null> = para.children.map((c) => {
			if (c !== lead) return c;
			if (stripped === "") return null;
			return { ...lead, value: stripped };
		});
		if (stripped === "") {
			while (inner.length && (inner[0] === null || (inner[0]?.type === "element" && inner[0].tagName === "br"))) inner.shift();
		}
		const hasSignificant = inner.some((c) => significant(c));
		const rebuilt = hasSignificant ? { ...para, children: inner.filter((c): c is ElementContent => c !== null) } : null;
		const out: ElementContent[] = [];
		for (const child of children) {
			if (child !== para) out.push(child);
			else if (rebuilt) out.push(rebuilt);
		}
		return { kind: match[1]!.toLowerCase(), children: out };
	}

	function tableToMarkdown(table: HTMLTableElement): string {
		const rows = [...table.rows].map((row) =>
			[...row.cells].map((cell) => (cell.textContent ?? "").replace(/\|/g, "\\|").trim()),
		);
		if (rows.length === 0) return "";
		const header = rows[0]!;
		const separator = header.map(() => "---");
		return [header, separator, ...rows.slice(1)].map((cells) => `| ${cells.join(" | ")} |`).join("\n");
	}

	let tableEl = $state<HTMLTableElement | null>(null);
</script>

{#if node.type === "text"}
	{node.value}
{:else if node.type === "raw"}
	{node.value}
{:else if node.type === "element"}
	{#if node.tagName === "pre"}
		{#if codeElement(node)}
			{@const code = codeElement(node)!}
			{#if codeLang(code) === "mermaid"}
				<MermaidBlock chart={hastText(code)} {incomplete} />
			{:else}
				<CodeBlock source={hastText(code)} lang={codeLang(code)} meta={codeMeta(code)} />
			{/if}
		{:else}
			<pre {...attrs(node)}>{#each node.children as child, i (i)}<HastNode node={child} {incomplete} />{/each}</pre>
		{/if}
	{:else if node.tagName === "lh-math"}
		<MathBlock tex={String(node.properties.tex ?? "")} display={node.properties.display === "true"} />
	{:else if node.tagName === "table"}
		<div class="group/md relative my-4" data-testid="md-table">
			<CopyCorner
				class="absolute top-1 right-1 z-10"
				label="Copy table"
				getText={() => (tableEl ? tableToMarkdown(tableEl) : "")}
			/>
			<div class="overflow-x-auto">
				<table bind:this={tableEl} class="w-full border-collapse" data-streamdown="table">
					{#each node.children as child, i (i)}<HastNode node={child} {incomplete} />{/each}
				</table>
			</div>
		</div>
	{:else if node.tagName === "blockquote"}
		{@const alert = parseAlert(node.children)}
		{#if alert}
			<div data-testid="md-callout" data-alert-kind={alert.kind} class="my-4 w-fit max-w-full border border-white px-4 py-3 [&> :first-child]:mt-0 [&> :last-child]:mb-0">
				{#each alert.children as child, i (i)}<HastNode node={child} {incomplete} />{/each}
			</div>
		{:else}
			<blockquote class="my-4 border-l-4 border-muted-foreground/30 pl-4 text-muted-foreground italic" data-streamdown="blockquote">
				{#each node.children as child, i (i)}<HastNode node={child} {incomplete} />{/each}
			</blockquote>
		{/if}
	{:else if node.tagName === "code"}
		<code
			class="rounded bg-muted px-1.5 py-0.5 font-mono text-sm"
			data-streamdown="inline-code"
			{...attrs(node)}
		>{#each node.children as child, i (i)}<HastNode node={child} {incomplete} />{/each}</code>
	{:else if node.tagName === "img"}
		<img {...attrs(node)} loading="lazy" />
	{:else if VOID.has(node.tagName)}
		<svelte:element this={node.tagName} {...attrs(node)} />
	{:else}
		<svelte:element this={node.tagName} {...attrs(node)}>
			{#each node.children as child, i (i)}<HastNode node={child} {incomplete} />{/each}
		</svelte:element>
	{/if}
{:else if node.type === "root"}
	{#each node.children as child, i (i)}<HastNode node={child} {incomplete} />{/each}
{/if}
