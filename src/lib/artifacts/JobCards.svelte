<script lang="ts">
	import type { ArtifactPartProps } from "@/src/session/model";
import type { JobRecord } from "@/src/jobs/model";
	import DispatchCard from "./DispatchCard.svelte";

	let { part, jobs }: { part: ArtifactPartProps["part"]; jobs: JobRecord[] } = $props();
	const kind = $derived(part.type === "tool-pdf" ? "pdf" : "research");
</script>

{#if part.state === "output-available"}
	<DispatchCard toolCallId={part.toolCallId} {kind} {jobs} />
{/if}
