<script lang="ts">
	let {
		levels,
		effectiveLevel,
		onPick,
		empty,
		footer,
	}: {
		levels: string[];
		effectiveLevel?: string;
		onPick: (level: string) => void;
		empty?: string;
		footer?: string;
	} = $props();
</script>

{#if levels.length === 0}
	<div class="px-2 py-3 text-center text-muted-foreground">{empty ?? "No thinking levels."}</div>
{:else}
	{#each levels as level (level)}
		<button
			type="button"
			data-testid={`thinking-option-${level}`}
			onclick={() => onPick(level)}
			class="flex items-center justify-between rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted {level === effectiveLevel ? 'bg-muted/60 text-card-foreground' : 'text-card-foreground'}"
		>
			<span>{level}</span>
			{#if level === effectiveLevel}<span aria-hidden="true">✓</span>{/if}
		</button>
	{/each}
{/if}
{#if footer}<div class="mt-1 border-t px-2 pt-1.5 text-xs text-muted-foreground">{footer}</div>{/if}
