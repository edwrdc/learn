<script lang="ts">
	import { dismissLayer } from "$lib/ui/layer";
	import { graphSnapshot } from "$lib/state/graph.svelte";
	import { hasPracticeMeta, practiceMetaRows, practiceTargets } from "./practice-meta";

	let {
		conclude,
		problem,
	}: {
		conclude: { outcome?: string; rung?: unknown; missClass?: unknown; retest?: unknown };
		problem: { mode?: unknown; target?: unknown };
	} = $props();

	let open = $state(false);
	let trigger = $state<HTMLButtonElement | null>(null);
	let box = $state<HTMLDivElement | null>(null);
	let anchor = $state<{ top: number; left: number } | null>(null);

	const visible = $derived(hasPracticeMeta({ conclude, problem }));
	const names = $derived.by(() => {
		const graph = open && practiceTargets(problem).length > 0 ? graphSnapshot.value : undefined;
		return graph ? Object.fromEntries(graph.nodes.map((node) => [node.id, node.name])) : null;
	});
	const rows = $derived(practiceMetaRows({ conclude, problem, names }));

	function toggle() {
		if (open) {
			open = false;
			return;
		}
		const rect = trigger?.getBoundingClientRect();
		if (rect) anchor = { top: rect.bottom + 8, left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)) };
		open = true;
	}

	$effect(() => {
		if (!open) return;
		return dismissLayer(() => (open = false), { inside: () => [trigger, box], capture: true, closeOnScroll: true });
	});
</script>

{#if visible}
	<div class="relative mt-3">
		<button
			type="button"
			bind:this={trigger}
			data-testid="metadata-toggle"
			onclick={toggle}
			aria-expanded={open}
			class="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
		>
			Metadata
		</button>
		{#if open && anchor}
			<div
				bind:this={box}
				data-testid="metadata-box"
				style={`position:fixed;top:${anchor.top}px;left:${anchor.left}px`}
				class="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-xl border bg-card p-4 text-left shadow-lg"
			>
				<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
					{#each rows as row (row.label)}
						<dt class="text-muted-foreground">{row.label}</dt>
						<dd class="font-mono">{row.value}</dd>
					{/each}
				</dl>
			</div>
		{/if}
	</div>
{/if}
