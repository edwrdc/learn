<script lang="ts">
import { untrack } from "svelte";
	import { ChevronDown } from "@lucide/svelte";
	import { cn } from "$lib/utils";
	import Markdown from "$lib/markdown/Markdown.svelte";
	import BrailleSpinner from "$lib/ui/BrailleSpinner.svelte";
	import { blurAfterPointerClick } from "./enter-submits";

	let { text, isStreaming = false }: { text: string; isStreaming?: boolean } = $props();
	let open = $state(false);
	let everStreamed = untrack(() => isStreaming);
	let autoClosed = false;

	$effect(() => {
		if (isStreaming) everStreamed = true;
	});
	$effect(() => {
		if (everStreamed && !isStreaming && open && !autoClosed) {
			const timer = setTimeout(() => {
				open = false;
				autoClosed = true;
			}, 1000);
			return () => clearTimeout(timer);
		}
	});
</script>

<div class="not-prose mb-4">
	<button
		type="button"
		onclick={(event) => {
			open = !open;
			blurAfterPointerClick(event);
		}}
		aria-expanded={open}
		class="flex w-full items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
	>
		{#if isStreaming}<BrailleSpinner label="Thinking" />{/if}
		{#if isStreaming}
			<span class="animate-pulse">Thinking...</span>
		{:else}
			<span>AGENT’S THINKING</span>
		{/if}
		<ChevronDown class={cn("size-4 transition-transform", open ? "rotate-180" : "rotate-0")} />
	</button>
	{#if open}
		<div class="mt-4 text-sm text-muted-foreground">
			<Markdown text={text} />
		</div>
	{/if}
</div>
