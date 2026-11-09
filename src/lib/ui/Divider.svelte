<script lang="ts">
	/** A labelled rule across the transcript (phase changes, compaction cuts). */
	let { label, testid }: { label: string; testid: string } = $props();
</script>

<div class="my-4 flex w-full items-center gap-3" data-testid={testid}>
	<span class="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden="true"></span>
	<span class="rounded-full border border-border/80 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
	<span class="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden="true"></span>
</div>
