<script lang="ts">
	import { cn } from "$lib/utils";
	import type { Snippet } from "svelte";

	let {
		checked,
		disabled = false,
		onChange,
		label,
		disc,
		title,
	}: {
		checked: boolean;
		disabled?: boolean;
		onChange: (next: boolean) => void;
		label: string;
		disc?: Snippet;
		title?: string;
	} = $props();

	const testid = $derived(`toggle-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
</script>

<button
	type="button"
	role="switch"
	aria-checked={checked}
	aria-label={label}
	{title}
	{disabled}
	data-testid={testid}
	onclick={() => onChange(!checked)}
	class={cn(
		"relative h-4.5 w-8 shrink-0 rounded-full border border-border transition-colors",
		checked ? "bg-muted-foreground" : "bg-muted",
		disabled && "cursor-not-allowed",
	)}
>
	{#if disc}
		<span
			class={cn(
				"absolute left-0 top-0.5 flex size-3 items-center justify-center rounded-full transition-transform",
				checked ? "translate-x-4 text-foreground" : "translate-x-0.5 text-muted-foreground",
			)}
		>
			{@render disc()}
		</span>
	{:else}
		<span
			class={cn(
				"absolute left-0 top-0.5 size-3 rounded-full transition-transform",
				checked ? "translate-x-4 bg-foreground" : "translate-x-0.5 bg-muted-foreground",
			)}
		></span>
	{/if}
</button>
