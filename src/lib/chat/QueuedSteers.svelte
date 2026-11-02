<script lang="ts">
	let { steers }: { steers: Array<{ id: string; text: string }> } = $props();
</script>

{#if steers.length > 0}
	<div class="flex flex-col items-end gap-0.5 pb-1 pr-4" data-testid="queued-steers">
		{#each steers as steer (steer.id)}
			<span title={steer.text} class="block max-w-[240px] truncate font-ui text-[11px] text-muted-foreground/60">{steer.text}</span>
		{/each}
	</div>
{/if}
