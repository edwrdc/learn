<script lang="ts">
	import { fuzzyScore, type ModelCatalogEntry } from "@/src/core";
	import { formatTokens } from "$lib/format";

	let {
		models,
		effectiveId,
		effectiveProvider,
		onPick,
		footer,
	}: {
		models: ModelCatalogEntry[] | undefined;
		effectiveId?: string;
		effectiveProvider?: string;
		onPick: (entry: ModelCatalogEntry) => void;
		footer?: string;
	} = $props();

	let query = $state("");
	let menuIdx = $state<number | null>(null);
	let searchEl = $state<HTMLInputElement | null>(null);
	let listEl = $state<HTMLUListElement | null>(null);

	$effect(() => {
		searchEl?.focus();
	});
	$effect(() => {
		if (menuIdx === null) return;
		listEl?.querySelector<HTMLElement>(`[data-idx="${menuIdx}"]`)?.scrollIntoView({ block: "nearest" });
	});

	const results = $derived(
		(models ?? [])
			.map((m) => ({ m, s: fuzzyScore(query, m.provider, m.id, m.name) }))
			.filter((r): r is { m: ModelCatalogEntry; s: number } => r.s !== null)
			.sort((a, b) => b.s - a.s || a.m.id.localeCompare(b.m.id))
			.map((r) => r.m),
	);

	function priceLabel(cost: ModelCatalogEntry["cost"]): string {
		if (!cost) return "price unknown";
		const fmt = (n: number) => `$${n < 1 ? n.toFixed(2).replace(/0$/, "") : n.toFixed(2)}`;
		return `${fmt(cost.input)}/${fmt(cost.output)}`;
	}
</script>

<input
	bind:this={searchEl}
	data-testid="model-search"
	value={query}
	oninput={(event) => {
		query = (event.currentTarget as HTMLInputElement).value;
		menuIdx = null;
	}}
	onkeydown={(event) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			event.stopPropagation();
			if (results.length === 0) return;
			menuIdx =
				event.key === "ArrowDown"
					? Math.min((menuIdx ?? -1) + 1, results.length - 1)
					: Math.max((menuIdx ?? results.length) - 1, 0);
		} else if (event.key === "Enter") {
			const chosen = results[menuIdx ?? 0];
			if (chosen) {
				event.preventDefault();
				event.stopPropagation();
				onPick(chosen);
			}
		}
	}}
	placeholder="Search models…"
	class="lh-input mb-1.5 w-full rounded-lg border bg-background px-2 py-1.5 text-foreground outline-none focus:ring-1 focus:ring-ring"
/>
{#if !models}
	<div class="px-2 py-3 text-center text-muted-foreground">Loading models…</div>
{:else if results.length === 0}
	<div class="px-2 py-3 text-center text-muted-foreground">No models match.</div>
{/if}
<ul bind:this={listEl} data-testid="model-list" class="flex max-h-72 flex-col overflow-y-auto px-1">
	{#each results as model, i (`${model.provider}/${model.id}`)}
		<li>
			<button
				type="button"
				data-testid={`model-option-${model.id.replace(/[^a-z0-9-]/gi, "_")}`}
				data-idx={i}
				onclick={() => onPick(model)}
				class="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted {i === menuIdx ? 'bg-accent/40 ring-1 ring-inset ring-border' : ''}{model.id === effectiveId && model.provider === (effectiveProvider ?? model.provider) && i !== menuIdx ? ' bg-muted/60' : ''}"
			>
				<span class="flex items-center justify-between gap-2">
					<span class="truncate text-card-foreground">{model.name}</span>
					<span class="shrink-0 tabular-nums text-muted-foreground" title="USD per 1M tokens in/out">{priceLabel(model.cost)}</span>
				</span>
				<span class="flex items-center justify-between gap-2 text-muted-foreground">
					<span class="truncate">{model.provider} · {model.id}</span>
					<span class="shrink-0 tabular-nums">{formatTokens(model.contextWindow)}</span>
				</span>
			</button>
		</li>
	{/each}
</ul>
{#if footer}<div class="mt-1 border-t px-2 pt-1.5 text-xs text-muted-foreground">{footer}</div>{/if}
