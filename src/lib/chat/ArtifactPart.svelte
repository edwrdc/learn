<script lang="ts">
	import type { ArtifactPartProps } from "@/src/session/model";
	import type { JobRecord } from "@/src/jobs/model";
	import { toolInfo } from "@/src/tools/model";
	import DispatchCard from "$lib/artifacts/DispatchCard.svelte";
	import ToolCallCard from "$lib/artifacts/ToolCallCard.svelte";
	import ProbeDoneCard from "$lib/artifacts/ProbeDoneCard.svelte";
	import PracticeCards from "./PracticeCards.svelte";

	let { part, jobs }: { part: ArtifactPartProps["part"]; jobs: JobRecord[] } = $props();
	const tool = $derived(part.type.replace(/^tool-/, ""));
</script>

{#if tool === "research" || tool === "pdf"}
	{#if part.state === "output-available"}
		<DispatchCard toolCallId={part.toolCallId} kind={tool} {jobs} />
	{/if}
{:else if tool === "demo" || tool === "visual"}
	<DispatchCard toolCallId={part.toolCallId} kind={tool} {jobs} />
{:else if tool === "probe_done"}
	<ProbeDoneCard {part} />
{:else if toolInfo(tool)?.kind === "side"}
	<ToolCallCard {part} />
{:else if toolInfo(tool)?.kind === "practice"}
	<PracticeCards {part} />
{/if}
