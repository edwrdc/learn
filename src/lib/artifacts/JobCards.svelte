<script lang="ts">
	import type { ArtifactPartProps, JobRecord } from "@/src/core";
	import DispatchCard from "./DispatchCard.svelte";

	let { part, jobs }: { part: ArtifactPartProps["part"]; jobs: JobRecord[] } = $props();
	const kind = $derived(part.type === "tool-pdf" ? "pdf" : "research");
</script>

{#if part.state === "output-available"}
	<DispatchCard toolCallId={part.toolCallId} {kind} {jobs} />
{/if}
