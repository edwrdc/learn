<script lang="ts">
	import type { ArtifactPartProps, PdfResult, ResearchResult } from "@/src/core";
	import Markdown from "$lib/markdown/Markdown.svelte";
	import DispatchCard from "./DispatchCard.svelte";

	let { part }: { part: ArtifactPartProps["part"] } = $props();
	const kind = $derived(part.type === "tool-pdf" ? "pdf" : "research");
</script>

{#if part.state === "output-available"}
	<DispatchCard toolCallId={part.toolCallId} {kind} />
{/if}
