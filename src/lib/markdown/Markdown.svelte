<script lang="ts">
	import { repairMathForDisplay, transformMathDelimiters } from "@/src/core";
	import HastNode from "./HastNode.svelte";
	import { hasOpenFence, markdownToHast } from "./pipeline";

	let {
		text = "",
		tool = false,
		class: className = "",
	}: {
		text: string;
		/** Tool text presentation: recover escape/JSON debris (display only). */
		tool?: boolean;
		class?: string;
	} = $props();

	const tree = $derived(markdownToHast(transformMathDelimiters(tool ? repairMathForDisplay(text) : text)));
	const incomplete = $derived(hasOpenFence(text));
</script>

<div class="lh-prose size-full space-y-4 whitespace-normal [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 {className}">
	{#each tree.children as child, i (i)}<HastNode node={child} {incomplete} />{/each}
</div>
