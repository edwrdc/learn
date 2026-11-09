<script lang="ts">
	import { fetchGraph } from "$lib/api/graph";
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
	let names = $state<Record<string, string> | null>(null);

	const visible = $derived(hasPracticeMeta({ conclude, problem }));
	const rows = $derived(practiceMetaRows({ conclude, problem, names }));

	function loadNames() {
		if (names || practiceTargets(problem).length === 0) return;
		void fetchGraph()
			.then((graph) => (names = Object.fromEntries(graph.nodes.map((node) => [node.id, node.name]))))
			.catch((error) => {
				console.error("[practice] proposition names unavailable:", error);
				names = {};
			});
	}

	function toggle() {
		if (open) {
			open = false;
			return;
		}
		loadNames();
		const rect = trigger?.getBoundingClientRect();
		if (rect) anchor = { top: rect.bottom + 8, left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)) };
		open = true;
	}

	$effect(() => {
		if (!open || typeof document === "undefined") return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (trigger?.contains(target) || box?.contains(target)) return;
			open = false;
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			open = false;
		};
		const onScroll = () => (open = false);
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKeyDown);
		window.addEventListener("scroll", onScroll, { capture: true, passive: true });
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("scroll", onScroll, { capture: true });
		};
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
