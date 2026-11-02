<script lang="ts">
	import { fuzzyScore } from "@/src/core";

	let {
		providers,
		onPick,
	}: { providers: { id: string; envVar: string; label: string }[]; onPick: (provider: { id: string; envVar: string; label: string }) => void } = $props();

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
		providers
			.map((p) => ({ p, s: fuzzyScore(query, p.id, p.envVar, p.label) }))
			.filter((r): r is { p: (typeof providers)[number]; s: number } => r.s !== null)
			.sort((a, b) => b.s - a.s || a.p.id.localeCompare(b.p.id))
			.map((r) => r.p),
	);
</script>

<input
	bind:this={searchEl}
	data-testid="provider-search"
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
	placeholder="Search providers…"
	class="lh-input mb-1.5 w-full rounded-lg border bg-background px-2 py-1.5 text-foreground outline-none focus:ring-1 focus:ring-ring"
/>
{#if results.length === 0}
	<div class="px-2 py-3 text-center text-muted-foreground">No providers match.</div>
{/if}
<ul bind:this={listEl} data-testid="provider-list" class="flex max-h-72 flex-col overflow-y-auto px-1">
	{#each results as provider, i (provider.id)}
		<li>
			<button
				type="button"
				data-testid={`provider-option-${provider.id.replace(/[^a-z0-9-]/gi, "_")}`}
				data-idx={i}
				onclick={() => onPick(provider)}
				class="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted {i === menuIdx ? 'bg-accent/40 ring-1 ring-inset ring-border' : ''}"
			>
				<span class="truncate text-card-foreground">{provider.label}</span>
				<span class="shrink-0 font-mono text-[11px] text-muted-foreground">{provider.envVar}</span>
			</button>
		</li>
	{/each}
</ul>
