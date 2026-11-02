<script lang="ts">
	import type { CompactionDetails } from "@/src/core";
	let { data, cut = false }: { data: { content: string; details: CompactionDetails }; cut?: boolean } = $props();
	const kTok = $derived(data.details.tokensBefore > 0 ? ` · ${Math.round(data.details.tokensBefore / 1000)}k tok` : "");
</script>

{#if cut}
	<div data-testid="compaction-cut-divider" class="my-4 flex w-full items-center gap-3">
		<span class="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden="true"></span>
		<span class="rounded-full border border-border/80 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">History compacted{kTok}</span>
		<span class="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden="true"></span>
	</div>
{:else}
	<div class="flex w-full items-center justify-center py-1">
		<span data-testid="compaction-divider" class="px-1.5 text-xs text-muted-foreground/70">Context compacted</span>
	</div>
{/if}
