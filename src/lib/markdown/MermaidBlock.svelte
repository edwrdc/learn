<script lang="ts">
	import { browser } from "$app/environment";
	import { getContext } from "svelte";
	import { SESSION_MERMAID } from "$lib/chat/session-context";
	import type { SessionMermaidApi } from "$lib/chat/types";
	import { hint } from "$lib/hint";
	import CopyCorner from "./CopyCorner.svelte";
	import MermaidError from "./MermaidError.svelte";
	import { chartSize, MERMAID_FONT_SIZE, renderMermaid } from "./mermaid";

	let { chart, incomplete = false }: { chart: string; incomplete?: boolean } = $props();

	const overlay = getContext<SessionMermaidApi | null>(SESSION_MERMAID) ?? null;

	let svg = $state<string | null>(null);
	let error = $state<string | null>(null);
	let attempt = $state(0);
	let holder = $state<HTMLDivElement | null>(null);
	let capW = $state<number | null>(null);

	$effect(() => {
		if (!browser || incomplete) return;
		attempt;
		let cancelled = false;
		svg = null;
		error = null;
		void renderMermaid(chart)
			.then((rendered) => {
				if (!cancelled) svg = rendered;
			})
			.catch((err: unknown) => {
				if (!cancelled) error = err instanceof Error ? err.message : String(err);
			});
		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		if (!svg || !holder) {
			capW = null;
			return;
		}
		const fontSize = Number.parseFloat(getComputedStyle(holder).fontSize);
		if (!Number.isFinite(fontSize) || fontSize <= 0) return;
		capW = (chartSize(svg).w * fontSize) / MERMAID_FONT_SIZE;
	});
</script>

{#if incomplete || (svg === null && error === null)}
	<div data-testid="md-mermaid" class="my-4 flex justify-center p-4" aria-busy="true">
		<span class="inline-block size-4 animate-spin rounded-full border border-current border-b-2 text-muted-foreground"></span>
	</div>
{:else if error !== null}
	<MermaidError {chart} {error} retry={() => (attempt += 1)} />
{:else}
	<div data-testid="md-mermaid" data-streamdown="mermaid" class="group/md relative my-4">
		<div
			bind:this={holder}
			class="mx-auto flex w-full justify-center"
			style={capW === null ? undefined : `max-width: ${capW}px`}
		>
			{@html svg}
		</div>
		<div class="absolute top-0 right-0 flex items-start gap-0.5">
			<CopyCorner getText={() => chart} label="Copy diagram source" />
			{#if overlay}
				<button
					type="button"
					aria-label="Expand diagram"
					data-testid="md-mermaid-expand"
					{@attach hint("Open full-screen", { side: "bottom" })}
					class="flex size-6 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/md:opacity-100"
					onclick={(event) => {
						if (event.detail !== 0) (event.currentTarget as HTMLElement).blur();
						overlay.openMermaid(chart);
					}}
				>
					<svg viewBox="0 0 24 24" class="size-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
				</button>
			{/if}
		</div>
	</div>
{/if}
