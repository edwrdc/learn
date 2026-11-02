<script lang="ts">
	import type { Snippet } from "svelte";
	import { cn } from "$lib/utils";

	let {
		kind,
		title,
		hint,
		label,
		testid,
		dimmed = false,
		children,
	}: {
		kind: "section" | "group" | "row";
		title?: string;
		hint?: string;
		label?: string;
		testid?: string;
		dimmed?: boolean;
		children?: Snippet;
	} = $props();
</script>

{#if kind === "section"}
	<section data-testid={testid} class="px-6 py-5">
		<h2 class="text-sm uppercase tracking-widest text-foreground">{title}</h2>
		{#if hint}<p class="mt-1 text-xs text-muted-foreground">{hint}</p>{/if}
		<div class="mt-4 flex flex-col gap-3">{@render children?.()}</div>
	</section>
{:else if kind === "group"}
	<div data-testid={testid} class="mt-5 border-t border-border/60 pt-4 first:mt-0 first:border-t-0 first:pt-0">
		<p class="mb-2 text-xs uppercase tracking-widest text-muted-foreground">{title ?? label}</p>
		<div class="flex flex-col gap-2">{@render children?.()}</div>
	</div>
{:else}
	<div data-testid={testid} class={cn("flex items-center justify-between gap-4 py-1", dimmed && "opacity-40")}>
		<span class="min-w-0">
			<span class="block font-prose text-(length:--lh-prose-size)">{label}</span>
			{#if hint}<span class="block text-xs text-muted-foreground/70">{hint}</span>{/if}
		</span>
		{@render children?.()}
	</div>
{/if}
