<script lang="ts">
	import { ListNav } from "$lib/ui/list-nav.svelte";
	import { customFamilyFor, fontMenuResults } from "./fonts";

	let {
		families,
		effectiveFamily,
		onPick,
		footer,
	}: { families: string[] | undefined; effectiveFamily: string | null; onPick: (family: string | null) => void; footer?: string } = $props();

	let query = $state("");
	let searchEl = $state<HTMLInputElement | null>(null);

	$effect(() => {
		searchEl?.focus();
	});


	const results = $derived(fontMenuResults(query, families ?? []));
	const custom = $derived(customFamilyFor(query, families ?? []));
	const walkable = $derived<Array<string | null>>(custom !== null ? ["__custom__"] : results);

	const nav = new ListNav(() => walkable, (value) => onPick(value === "__custom__" ? custom : value));
</script>

<input
	bind:this={searchEl}
	data-testid="font-search"
	value={query}
	oninput={(event) => {
		query = (event.currentTarget as HTMLInputElement).value;
		nav.reset();
	}}
	onkeydown={nav.keydown}
	placeholder="Search fonts…"
	class="lh-input mb-1.5 w-full rounded-lg border bg-background px-2 py-1.5 text-foreground outline-none focus:ring-1 focus:ring-ring"
/>
{#if !families}
	<div class="px-2 py-3 text-center text-muted-foreground">Loading fonts…</div>
{:else}
	<ul data-testid="font-list" class="flex max-h-72 flex-col overflow-y-auto px-1">
		{#each results as family, i (family ?? "__default")}
			{@const isDefault = family === null}
			{@const effective = isDefault ? effectiveFamily === null : family === effectiveFamily}
			<li>
				<button
					type="button"
					data-testid={isDefault ? "font-option-default" : `font-option-${family.replace(/[^a-z0-9-]/gi, "_")}`}
					data-idx={i}
					onclick={() => onPick(family)}
					class="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted {i === nav.index ? 'bg-accent/40 ring-1 ring-inset ring-border' : ''}{effective && i !== nav.index ? ' bg-muted/60' : ''}"
				>
					<span class="truncate text-card-foreground">{family ?? "Source Sans 3"}</span>
					<span class="shrink-0 text-muted-foreground">{isDefault ? "default" : effective ? "✓" : ""}</span>
				</button>
			</li>
		{/each}
		{#if custom !== null}
			<li>
				<button type="button" data-testid="font-option-custom" data-idx={0} onclick={() => onPick(custom)} class="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted {nav.index === 0 ? 'bg-accent/40 ring-1 ring-inset ring-border' : ''}">
					<span class="truncate text-card-foreground">Use “{custom}”</span>
					<span class="shrink-0 text-muted-foreground">custom</span>
				</button>
			</li>
		{/if}
	</ul>
{/if}
{#if footer}<div class="px-2 pt-1.5 text-xs text-muted-foreground">{footer}</div>{/if}
