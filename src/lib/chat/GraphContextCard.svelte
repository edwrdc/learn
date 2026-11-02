<script lang="ts">
	import { ChevronRight } from "@lucide/svelte";
	import { cn } from "$lib/utils";

	interface GraphContextData {
		propositions: { id: string; name: string; statement: string }[];
		chains: string[];
	}
	let { data }: { data: GraphContextData } = $props();
	let open = $state(false);
	const propositions = $derived(data?.propositions ?? []);
	const chains = $derived(data?.chains ?? []);
	const noun = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
</script>

<div data-testid="graph-context-card" class="my-1">
	<button
		type="button"
		data-testid="graph-context-toggle"
		onclick={() => (open = !open)}
		class="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
	>
		<ChevronRight aria-hidden="true" class={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
		<span class="font-medium">Graph context</span>
		<span class="min-w-0 flex-1 truncate">
			{noun(propositions.length, "proposition", "propositions")}{chains.length > 0 ? ` · ${noun(chains.length, "chain", "chains")}` : ""}
		</span>
	</button>
	{#if open}
		<div data-testid="graph-context-body" class="mt-1 space-y-1 rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs">
			{#each propositions as proposition (proposition.id)}
				<div data-testid={`graph-context-prop-${proposition.id}`} class="leading-relaxed">
					<span class="font-medium text-foreground/80">{proposition.name}</span>
					<span class="text-muted-foreground"> — {proposition.statement}</span>
				</div>
			{/each}
			{#if chains.length > 0}
				<div class="pt-1">
					{#each chains as chain, i (i)}
						<div class="font-mono text-[11px] text-muted-foreground">{chain}</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>
