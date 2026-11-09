<script lang="ts">
	import { dismissLayer } from "$lib/ui/layer";
	import { ringFill } from "./coverage";
	import { formatTokens, timeAgo } from "$lib/format";
	import { hint } from "$lib/hint";
	import { activity } from "$lib/state/activity.svelte";
	import { chatCoverage } from "$lib/state/coverage.svelte";
	import { settings } from "$lib/state/settings.svelte";


	let { chatId, refreshKey = 0 }: { chatId: string; refreshKey?: number } = $props();
	const graph = $derived(settings.resolved?.graph);
	const store = $derived(chatCoverage(chatId));
	const coverage = $derived(store.value);
	let open = $state(false);
	let root = $state<HTMLDivElement | null>(null);

	const runHere = $derived((activity.value?.extractions ?? []).some((run) => run.chatId === chatId));

	$effect(() => {
		void refreshKey;
		void runHere;
		void store.refresh();
	});
	$effect(() => {
		if (!open) return;
		return dismissLayer(() => (open = false), { inside: () => [root] });
	});

	const fill = $derived(graph && coverage ? ringFill(coverage.uncoveredTokens, graph.extractionChunkTokens) : 0);
	const C = 2 * Math.PI * 6;
</script>

{#if graph?.enabled && coverage}
	<div bind:this={root} class="lh-no-drag relative shrink-0">
		<button
			type="button"
			data-testid="coverage-ring"
			onclick={() => (open = !open)}
			aria-label="Extraction coverage"
			aria-expanded={open}
			{@attach hint("How much of this session isn't mapped yet", { side: "bottom" })}
			class="relative flex size-5 cursor-pointer items-center justify-center transition-opacity hover:opacity-80"
		>
			<svg viewBox="0 0 16 16" class={coverage.running ? "size-full animate-pulse" : "size-full"} aria-hidden="true">
				<circle cx="8" cy="8" r="6" fill="none" stroke-width="2.5" class="stroke-border" />
				<circle cx="8" cy="8" r="6" fill="none" stroke-width="2.5" class="stroke-foreground/70" stroke-dasharray="{fill * C} {C}" stroke-linecap="round" transform="rotate(-90 8 8)" />
			</svg>
		</button>
		{#if open}
			<div data-testid="coverage-ring-popover" class="absolute top-full right-0 z-40 mt-1.5 w-64 rounded-xl border bg-card p-3 text-xs shadow-xl">
				<div class="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Extraction coverage</div>
				<div class="flex flex-col gap-1 text-muted-foreground">
					<div class="flex justify-between gap-2"><span>Uncovered</span><span class="tabular-nums text-card-foreground">{formatTokens(coverage.uncoveredTokens)} tokens</span></div>
					<div class="flex justify-between gap-2"><span>Covered</span><span class="tabular-nums text-card-foreground">{formatTokens(coverage.coveredTokens)} tokens</span></div>
					<div class="flex justify-between gap-2"><span>Messages</span><span class="tabular-nums text-card-foreground">{coverage.coveredCount} / {coverage.totalMessages}</span></div>
					<div class="flex justify-between gap-2"><span>Chunk threshold</span><span class="tabular-nums text-card-foreground">{formatTokens(graph.extractionChunkTokens)} tokens</span></div>
					<div class="flex justify-between gap-2"><span>Last extraction</span><span class="tabular-nums text-card-foreground">{coverage.lastFoldedAt ? timeAgo(coverage.lastFoldedAt) : "—"}</span></div>
					{#if coverage.running}
						<div class="flex justify-between gap-2" data-testid="coverage-ring-running"><span>Status</span><span class="text-card-foreground">extracting…</span></div>
					{/if}
				</div>
			</div>
		{/if}
	</div>
{/if}
