<script lang="ts">
	import { dismissLayer } from "$lib/ui/layer";
	import { X } from "@lucide/svelte";
	import { derivedNodeStatus, derivePlanStatuses, type PlanNodeStatus } from "@/src/session/model";
	import { hint } from "$lib/hint";
	import { backdropDismiss } from "$lib/backdrop";
	import PanZoomViewer from "$lib/ui/PanZoomViewer.svelte";
	import PlanDiagram from "./PlanDiagram.svelte";
	import { GLOW_REACH, blockLayout, latestTree, type PopupMessage } from "./plan-layout";

	let { messages, onClose }: { messages: readonly PopupMessage[]; onClose: () => void } = $props();

	const uid = $props.id();
	const markerId = `plan-popup-${uid}`;
	const POPUP_PAD = GLOW_REACH;
	const tree = $derived(latestTree(messages));
	const statuses = $derived(tree ? derivePlanStatuses(tree, messages as Parameters<typeof derivePlanStatuses>[1]) : null);
	const statusOf = (id: string): PlanNodeStatus => (statuses ? derivedNodeStatus(statuses, id) : "upcoming");
	const layout = $derived(tree ? blockLayout(tree.nodes, tree.edges) : null);
	const box = $derived(layout ? { w: layout.width + 2 * POPUP_PAD, h: layout.height + 2 * POPUP_PAD } : null);

	$effect(() => dismissLayer(onClose, { clickOutside: false }));
</script>

<div
	data-testid="plan-popup"
	class="absolute inset-0 z-40 flex flex-col bg-background/80 p-4 backdrop-blur-sm"
	role="dialog"
	aria-modal="true"
	aria-label="The full plan"
	tabindex={-1}
	{@attach backdropDismiss(onClose)}
>
	<div class="mb-2 flex items-center gap-2">
		<span class="text-sm font-medium">The plan</span>
		<span class="text-xs text-muted-foreground">live — statuses derive from your check outcomes</span>
		<button type="button" onclick={onClose} aria-label="Close" data-testid="plan-popup-close" {@attach hint("Close", { binding: "escape", side: "left" })} class="ml-auto rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
			<X class="size-4" />
		</button>
	</div>
	<PanZoomViewer box={tree ? box : null} label="Plan viewport" fitLabel="Fit plan to screen" fitTestid="plan-popup-fit">
		{#if tree}
			<PlanDiagram nodes={tree.nodes} edges={tree.edges} {statusOf} glowId={statuses?.current ?? null} {markerId} pad={POPUP_PAD} variant="popup" />
		{/if}
		{#snippet fallback()}
			<div class="flex h-full items-center justify-center text-sm text-muted-foreground">No plan in this session yet.</div>
		{/snippet}
	</PanZoomViewer>
</div>
