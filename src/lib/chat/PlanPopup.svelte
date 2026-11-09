<script lang="ts">
	import { Maximize, Minus, Plus, X } from "@lucide/svelte";
	import { derivedNodeStatus, derivePlanStatuses, type PlanNodeStatus } from "@/src/session/model";
	import { hint } from "$lib/hint";
	import { backdropDismiss } from "$lib/backdrop";
	import { fitGraphView, fitZoomFor, zoomedGraphView, type Viewport } from "$lib/home/pan-zoom.ts";
	import PlanDiagram from "./PlanDiagram.svelte";
	import { GLOW_REACH, blockLayout, latestTree, type PopupMessage } from "./plan-layout";

	let { messages, onClose }: { messages: readonly PopupMessage[]; onClose: () => void } = $props();
	let seq = 0;
	const markerId = `plan-popup-${++seq}`;
	const POPUP_PAD = GLOW_REACH;
	const tree = $derived(latestTree(messages));
	const statuses = $derived(tree ? derivePlanStatuses(tree, messages as Parameters<typeof derivePlanStatuses>[1]) : null);
	const statusOf = (id: string): PlanNodeStatus => (statuses ? derivedNodeStatus(statuses, id) : "upcoming");
	const layout = $derived(tree ? blockLayout(tree.nodes, tree.edges) : null);
	const box = $derived(layout ? { w: layout.width + 2 * POPUP_PAD, h: layout.height + 2 * POPUP_PAD } : { w: 0, h: 0 });

	let viewport = $state<HTMLDivElement | null>(null);
	let size = $state({ w: 0, h: 0 });
	let view = $state<Viewport>({ x: 0, y: 0, zoom: 1 });
	let settled = $state(false);
	let panning = $state(false);
	let userAdjusted = false;
	let drag: { px: number; py: number; x: number; y: number; moved: boolean } | null = null;
	const fitZoom = $derived(fitZoomFor(box, size));
	const atFloor = $derived(view.zoom <= fitZoom + 1e-9);

	$effect(() => {
		if (typeof document === "undefined") return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	});

	$effect(() => {
		const el = viewport;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => (size = { w: el.clientWidth, h: el.clientHeight }));
		ro.observe(el);
		return () => ro.disconnect();
	});

	$effect(() => {
		if (atFloor) userAdjusted = false;
	});
	$effect(() => {
		if (userAdjusted || !size.w || !size.h) return;
		view = fitGraphView(box, size, fitZoom);
		const raf = requestAnimationFrame(() => (settled = true));
		return () => cancelAnimationFrame(raf);
	});

	$effect(() => {
		const el = viewport;
		if (!el) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const dy = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
			const factor = Math.exp(-dy * 0.0015);
			const rect = el.getBoundingClientRect();
			view = zoomedGraphView(view, factor, fitZoom, { x: event.clientX - rect.left, y: event.clientY - rect.top }, box, size);
			userAdjusted = true;
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	});

	function stepZoom(factor: number) {
		userAdjusted = true;
		view = zoomedGraphView(view, factor, fitZoom, { x: size.w / 2, y: size.h / 2 }, box, size);
	}
	function fitView() {
		userAdjusted = false;
		if (!size.w || !size.h) return;
		view = fitGraphView(box, size, fitZoom);
	}
	function startDrag(event: PointerEvent) {
		if (event.button !== 0 || (event.target as HTMLElement).closest("button") || atFloor) return;
		drag = { px: event.clientX, py: event.clientY, x: view.x, y: view.y, moved: false };
		panning = true;
		(event.currentTarget as HTMLElement).classList.add("cursor-grabbing");
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}
	function moveDrag(event: PointerEvent) {
		if (!drag) return;
		drag.moved = true;
		view = { ...view, x: drag.x + (event.clientX - drag.px), y: drag.y + (event.clientY - drag.py) };
	}
	function endDrag(event: PointerEvent) {
		if (drag?.moved) userAdjusted = true;
		drag = null;
		panning = false;
		(event.currentTarget as HTMLElement).classList.remove("cursor-grabbing");
	}
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
	<div
		bind:this={viewport}
		role="group"
		aria-label="Plan viewport"
		class="relative min-h-0 flex-1 touch-none overflow-hidden rounded-xl border select-none {atFloor ? 'cursor-default' : 'cursor-grab'}"
		onpointerdown={startDrag}
		onpointermove={moveDrag}
		onpointerup={endDrag}
		onpointercancel={endDrag}
	>
		{#if tree}
			<div
				class="absolute top-0 left-0 origin-top-left"
				style="transform: translate({view.x}px, {view.y}px) scale({view.zoom}); opacity: {settled ? 1 : 0}; transition: {panning || !settled ? 'none' : 'transform 180ms ease-out, opacity 160ms ease-out'}"
			>
				<PlanDiagram nodes={tree.nodes} edges={tree.edges} {statusOf} glowId={statuses?.current ?? null} {markerId} pad={POPUP_PAD} naturalSize />
			</div>
			<div class="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between p-2">
				<span class="text-xs text-muted-foreground/60">Drag to pan · scroll to zoom</span>
				<div class="flex gap-1">
					<button type="button" aria-label="Zoom out" onclick={() => stepZoom(1 / 1.25)} {@attach hint("Zoom out", { side: "bottom" })} class="pointer-events-auto flex size-7 items-center justify-center rounded-md border border-border/70 bg-card/80 text-muted-foreground backdrop-blur transition-colors hover:bg-accent hover:text-foreground"><Minus class="size-3.5" /></button>
					<button type="button" aria-label="Fit plan to screen" onclick={fitView} data-testid="plan-popup-fit" {@attach hint("Fit plan to screen", { side: "bottom" })} class="pointer-events-auto flex size-7 items-center justify-center rounded-md border border-border/70 bg-card/80 text-muted-foreground backdrop-blur transition-colors hover:bg-accent hover:text-foreground"><Maximize class="size-3.5" /></button>
					<button type="button" aria-label="Zoom in" onclick={() => stepZoom(1.25)} {@attach hint("Zoom in", { side: "bottom" })} class="pointer-events-auto flex size-7 items-center justify-center rounded-md border border-border/70 bg-card/80 text-muted-foreground backdrop-blur transition-colors hover:bg-accent hover:text-foreground"><Plus class="size-3.5" /></button>
				</div>
			</div>
		{:else}
			<div class="flex h-full items-center justify-center text-sm text-muted-foreground">No plan in this session yet.</div>
		{/if}
	</div>
</div>
