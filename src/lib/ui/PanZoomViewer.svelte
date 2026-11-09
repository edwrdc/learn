<script lang="ts">
	import type { Snippet } from "svelte";
	import { Maximize, Minus, Plus } from "@lucide/svelte";
	import { hint } from "$lib/hint";
	import { fitGraphView, fitZoomFor, zoomedGraphView, type Viewport } from "./pan-zoom";

	/** A drag-to-pan, scroll-to-zoom view of content with a known natural
	 *  size. It fits the content until the user zooms or pans; zooming back
	 *  out to the fit floor resumes fitting. */
	let {
		box,
		label,
		fitLabel,
		fitTestid,
		sizedContent = false,
		children,
		fallback,
	}: {
		/** The content's natural size; null while there is nothing to show. */
		box: { w: number; h: number } | null;
		label: string;
		fitLabel: string;
		fitTestid?: string;
		/** Give the content the natural width (raw SVG scales to its box). */
		sizedContent?: boolean;
		children: Snippet;
		fallback: Snippet;
	} = $props();

	let viewport = $state<HTMLDivElement | null>(null);
	let size = $state({ w: 0, h: 0 });
	let view = $state<Viewport>({ x: 0, y: 0, zoom: 1 });
	let settled = $state(false);
	let panning = $state(false);
	let userAdjusted = false;
	let drag: { px: number; py: number; x: number; y: number; moved: boolean } | null = null;

	const natural = $derived(box ?? { w: 0, h: 0 });
	const fitZoom = $derived(fitZoomFor(natural, size));
	const atFloor = $derived(view.zoom <= fitZoom + 1e-9);

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
		if (userAdjusted || !size.w || !size.h || !box) return;
		view = fitGraphView(natural, size, fitZoom);
		const raf = requestAnimationFrame(() => (settled = true));
		return () => cancelAnimationFrame(raf);
	});

	$effect(() => {
		const el = viewport;
		if (!el) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const dy = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
			const rect = el.getBoundingClientRect();
			view = zoomedGraphView(view, Math.exp(-dy * 0.0015), fitZoom, { x: event.clientX - rect.left, y: event.clientY - rect.top }, natural, size);
			userAdjusted = true;
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	});

	function stepZoom(factor: number) {
		userAdjusted = true;
		view = zoomedGraphView(view, factor, fitZoom, { x: size.w / 2, y: size.h / 2 }, natural, size);
	}
	function fitView() {
		userAdjusted = false;
		if (!size.w || !size.h) return;
		view = fitGraphView(natural, size, fitZoom);
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

	const CONTROL = "pointer-events-auto flex size-7 items-center justify-center rounded-md border border-border/70 bg-card/80 text-muted-foreground backdrop-blur transition-colors hover:bg-accent hover:text-foreground";
</script>

<div
	bind:this={viewport}
	role="group"
	aria-label={label}
	class="relative min-h-0 flex-1 touch-none overflow-hidden rounded-xl border select-none {atFloor ? 'cursor-default' : 'cursor-grab'}"
	onpointerdown={startDrag}
	onpointermove={moveDrag}
	onpointerup={endDrag}
	onpointercancel={endDrag}
>
	{#if box}
		<div
			class="absolute top-0 left-0 origin-top-left"
			style="{sizedContent ? `width: ${natural.w}px; ` : ''}transform: translate({view.x}px, {view.y}px) scale({view.zoom}); opacity: {settled ? 1 : 0}; transition: {panning || !settled ? 'none' : 'transform 180ms ease-out, opacity 160ms ease-out'}"
		>
			{@render children()}
		</div>
		<div class="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between p-2">
			<span class="text-xs text-muted-foreground/60">Drag to pan · scroll to zoom</span>
			<div class="flex gap-1">
				<button type="button" aria-label="Zoom out" onclick={() => stepZoom(1 / 1.25)} {@attach hint("Zoom out", { side: "bottom" })} class={CONTROL}><Minus class="size-3.5" /></button>
				<button type="button" aria-label={fitLabel} onclick={fitView} data-testid={fitTestid} {@attach hint(fitLabel, { side: "bottom" })} class={CONTROL}><Maximize class="size-3.5" /></button>
				<button type="button" aria-label="Zoom in" onclick={() => stepZoom(1.25)} {@attach hint("Zoom in", { side: "bottom" })} class={CONTROL}><Plus class="size-3.5" /></button>
			</div>
		</div>
	{:else}
		{@render fallback()}
	{/if}
</div>
