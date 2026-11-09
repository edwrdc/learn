<script lang="ts">
	import { dismissLayer } from "$lib/ui/layer";
	import { X } from "@lucide/svelte";
	import PanZoomViewer from "$lib/ui/PanZoomViewer.svelte";
	import { hint } from "$lib/hint";
	import { chartSize } from "$lib/markdown/mermaid";
	import { MermaidRender } from "$lib/markdown/mermaid-render.svelte";
	import MermaidError from "$lib/markdown/MermaidError.svelte";
	import SvgImage from "$lib/artifacts/SvgImage.svelte";
	import { INVERT_FILTER } from "$lib/artifacts/inverted.svelte";

	let {
		chart,
		svg: rawSvg,
		inverted = false,
		onClose,
	}: { chart?: string; svg?: string; inverted?: boolean; onClose: () => void } = $props();

	const render = new MermaidRender(() => (rawSvg === undefined ? chart : undefined));
	const rendered = $derived(rawSvg ?? render.svg);
	const error = $derived(rawSvg === undefined ? render.error : null);

	const box = $derived(rendered ? chartSize(rendered) : null);


	$effect(() => dismissLayer(onClose, { clickOutside: false }));

</script>

<div data-testid="mermaid-overlay" class="absolute inset-0 z-40 flex flex-col bg-background/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Diagram focus">
	<div class="mb-2 flex items-center gap-2">
		<span class="text-sm font-medium">Diagram</span>
		<span class="text-xs text-muted-foreground">from this lesson</span>
		<button type="button" onclick={onClose} aria-label="Close" data-testid="mermaid-overlay-close" {@attach hint("Close", { binding: "escape", side: "left" })} class="ml-auto rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"><X class="size-4" /></button>
	</div>
	<PanZoomViewer {box} label="Diagram viewport" fitLabel="Fit diagram to view" sizedContent>
		{#if rawSvg !== undefined && rendered}
			<div data-lh-overlay-chart class="bg-white" style={inverted ? INVERT_FILTER : undefined}>
				<SvgImage svg={rendered} class="block h-auto w-full" />
			</div>
		{:else if rendered}
			<div data-lh-overlay-chart class="[&_svg]:h-auto [&_svg]:w-full">{@html rendered}</div>
		{/if}
		{#snippet fallback()}
			{#if error}
				<div class="flex h-full items-center justify-center p-4"><MermaidError chart={chart ?? ""} {error} retry={render.retry} /></div>
			{:else}
				<div class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
					<span class="inline-block size-4 animate-spin rounded-full border border-current border-b-2"></span>
					Rendering diagram…
				</div>
			{/if}
		{/snippet}
	</PanZoomViewer>
</div>
