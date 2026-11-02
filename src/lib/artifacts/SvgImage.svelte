<script lang="ts">
	import { svgImageSource } from "./svg";
	let { svg, class: className = "", width }: { svg: string; class?: string; width?: number } = $props();


	const src = $derived(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgImageSource(svg))}`);
</script>

<img {src} alt="Figure" class={className} {width} draggable="false" />
