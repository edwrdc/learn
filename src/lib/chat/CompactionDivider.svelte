<script lang="ts">
	import Divider from "$lib/ui/Divider.svelte";
	import type { CompactionDetails } from "@/src/session/model";
	let { data, cut = false }: { data: { content: string; details: CompactionDetails }; cut?: boolean } = $props();
	const kTok = $derived(data.details.tokensBefore > 0 ? ` · ${Math.round(data.details.tokensBefore / 1000)}k tok` : "");
</script>

{#if cut}
	<Divider label="History compacted{kTok}" testid="compaction-cut-divider" />
{:else}
	<div class="flex w-full items-center justify-center py-1">
		<span data-testid="compaction-divider" class="px-1.5 text-xs text-muted-foreground/70">Context compacted</span>
	</div>
{/if}
