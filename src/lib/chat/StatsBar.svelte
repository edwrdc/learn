<script lang="ts">
	import type { Snippet } from "svelte";
	import { contextWindow, sessionCost, turnCost, type TurnUsage } from "@/src/session/model";
	import { formatTokens, formatUsd, prettyModel } from "$lib/format";
	import ModelControl from "./ModelControl.svelte";
	import { catalogLimits, modelCatalog } from "$lib/state/model-catalog.svelte";

	let {
		turns,
		dictationSlot,
		chatId,
		leadingSlot,
	}: {
		turns: TurnUsage[];
		dictationSlot?: Snippet;
		chatId?: string;
		leadingSlot?: Snippet;
	} = $props();

	let open = $state(false);
	let bar = $state<HTMLDivElement | null>(null);
	modelCatalog.ensure();

	$effect(() => {
		if (!open || typeof document === "undefined") return;
		const onPointerDown = (event: PointerEvent) => {
			if (bar && !bar.contains(event.target as Node)) open = false;
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			open = false;
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	});

	const limits = $derived(modelCatalog.catalog ? catalogLimits(modelCatalog.catalog) : undefined);
	const ctx = $derived(contextWindow({ turns }, limits));
	const costInfo = $derived(sessionCost({ turns }));
	const pricedCount = $derived(turns.length - costInfo.unpriced);
	const costLabel = $derived(pricedCount > 0 ? formatUsd(costInfo.cost) : "—");
</script>

<div
	data-testid="stats-bar"
	class="pointer-events-auto relative flex items-center justify-between gap-3 px-3 pt-2 text-xs text-muted-foreground"
>
	{@render leadingSlot?.()}
	{#if turns.length > 0}
		<div bind:this={bar} class="relative">
			<button
				type="button"
				onclick={() => (open = !open)}
				aria-expanded={open}
				data-testid="stats-summary"
				class="flex items-center gap-1.5 tabular-nums transition-colors hover:text-foreground"
			>
				<span data-testid="stats-context">{ctx ? (ctx.limit !== null ? `${formatTokens(ctx.usedTokens)} / ${formatTokens(ctx.limit)}` : formatTokens(ctx.usedTokens)) : "—"}</span>
				<span aria-hidden="true">·</span>
				<span data-testid="stats-cost">{costLabel}</span>
			</button>
			{#if open}
				<div data-testid="stats-detail" class="absolute bottom-full left-1/2 z-40 mb-1.5 w-72 -translate-x-1/2 rounded-xl border bg-card p-3 text-xs shadow-xl">
					<div class="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Session stats</div>
					<div class="flex flex-col gap-1 text-muted-foreground">
						<div class="flex justify-between gap-2">
							<span>Context (last call)</span>
							<span class="tabular-nums text-card-foreground">{ctx ? (ctx.limit !== null ? `${formatTokens(ctx.usedTokens)} / ${formatTokens(ctx.limit)}` : formatTokens(ctx.usedTokens)) : "—"}</span>
						</div>
						<div class="flex justify-between gap-2">
							<span>Total cost</span>
							<span class="tabular-nums text-card-foreground">{costLabel}</span>
						</div>
						{#if costInfo.unpriced > 0}
							<div class="flex justify-between gap-2"><span>Unpriced turns</span><span class="tabular-nums text-card-foreground">{costInfo.unpriced}</span></div>
						{/if}
					</div>
					{#if turns.length > 0}
						<div class="mb-1 mt-2.5 border-t pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Turns</div>
						<ul class="flex max-h-56 flex-col gap-1 overflow-y-auto">
							{#each turns as turn, i (i)}
								{@const c = turnCost(turn)}
								<li class="flex items-center justify-between gap-2">
									<span class="truncate text-muted-foreground">#{i + 1} · {prettyModel(turn.model, true)}</span>
									<span class="flex shrink-0 items-center gap-2 tabular-nums text-card-foreground">
										<span class="text-muted-foreground">{turn.steps.length} steps</span>
										<span>{c === null ? "—" : formatUsd(c)}</span>
									</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
	{#if dictationSlot}
		<div class="flex min-w-0 flex-1 items-center justify-center">{@render dictationSlot()}</div>
	{/if}
	<ModelControl {chatId} />
</div>
