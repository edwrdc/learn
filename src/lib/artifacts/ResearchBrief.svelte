<script lang="ts">
	import type { PdfResult, ResearchResult } from "@/src/jobs/model";
	import Markdown from "$lib/markdown/Markdown.svelte";

	let { output, kind = "research" }: { output: unknown; kind?: "research" | "pdf" } = $props();

	const research = $derived(kind === "research" ? (output as ResearchResult | undefined) : undefined);
	const pdf = $derived(kind === "pdf" ? (output as PdfResult | undefined) : undefined);
	const failed = $derived(
		research ? research.brief.startsWith("Research failed") : pdf ? pdf.brief.startsWith("PDF failed") : false,
	);
	const readList = $derived(pdf ? (pdf.pagesRead ?? pdf.pagesConsulted ?? []) : []);
	const consultedList = $derived(pdf?.pagesConsulted ?? []);
</script>

{#if kind === "research"}
	{#if !research || typeof research.brief !== "string"}
		<div class="rounded-xl border bg-card p-4 text-sm text-muted-foreground">Research completed, but the result could not be displayed.</div>
	{:else}
		<div class="rounded-xl border bg-card p-4 text-card-foreground" data-testid="research-brief-card">
			<div class="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Research brief
				{#if failed}<span class="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>{/if}
			</div>
			<div class="text-sm [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"><Markdown text={research.brief} /></div>
			{#if research.sources.length > 0}
				<div class="mt-3 border-t pt-2">
					<div class="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Sources</div>
					<ul class="flex flex-col gap-0.5 text-xs">
						{#each research.sources as source (source.url)}
							<li class="truncate"><a href={source.url} target="_blank" rel="noopener noreferrer" class="text-primary underline-offset-2 hover:underline">{source.title}</a></li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
	{/if}
{:else}
	{#if !pdf || typeof pdf.brief !== "string"}
		<div class="rounded-xl border bg-card p-4 text-sm text-muted-foreground">PDF reading completed, but the result could not be displayed.</div>
	{:else}
		<div class="rounded-xl border bg-card p-4 text-card-foreground" data-testid="pdf-brief-card">
			<div class="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				PDF brief
				{#if failed}<span class="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>{/if}
			</div>
			<div class="text-sm [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"><Markdown text={pdf.brief} /></div>
			{#if !failed && readList.length > 0}
				<div class="mt-3 border-t pt-2 text-xs text-muted-foreground">Pages read: {readList.join(", ")}</div>
			{/if}
			{#if !failed && consultedList.length > readList.length}
				<div class="mt-3 border-t pt-2 text-xs text-muted-foreground">Pages consulted: {consultedList.join(", ")}</div>
			{/if}
		</div>
	{/if}
{/if}
