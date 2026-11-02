<script lang="ts">
	import katex from "katex";
	import CopyCorner from "./CopyCorner.svelte";

	let { tex, display = false }: { tex: string; display?: boolean } = $props();

	// Own options only: KaTeX's read side must never inherit trust/schema
	// authority from a polluted Object.prototype (GHSA-238p-pmpm-9mq7).
	const html = $derived(
		katex.renderToString(tex, {
			displayMode: display,
			throwOnError: false,
			strict: false,
			trust: false,
			output: "htmlAndMathml",
		}),
	);
</script>

{#if display}
	<span class="group/md relative block z-0" data-testid="md-math">
		<CopyCorner
			class="absolute top-0 right-0 z-10"
			label="Copy equation source"
			getText={() => tex}
		/>
		<span>{@html html}</span>
	</span>
{:else}
	<span>{@html html}</span>
{/if}
