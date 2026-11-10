<script lang="ts">
	import type { ArtifactPartProps } from "@/src/session/model";
	import type { JobRecord } from "@/src/jobs/model";
	import { JOB_KINDS, toolInfo } from "@/src/tools/model";
	import DispatchCard from "$lib/artifacts/DispatchCard.svelte";
	import ToolCallCard from "$lib/artifacts/ToolCallCard.svelte";
	import ProbeDoneCard from "$lib/artifacts/ProbeDoneCard.svelte";
	import PracticeCards from "./PracticeCards.svelte";

	let { part, jobs }: { part: ArtifactPartProps["part"]; jobs: JobRecord[] } = $props();
	const tool = $derived(part.type.replace(/^tool-/, ""));
	const jobKind = $derived(JOB_KINDS.find((k) => k === tool));
</script>

{#if jobKind}
	<DispatchCard toolCallId={part.toolCallId} kind={jobKind} {jobs} />
{:else if tool === "probe_done"}
	<ProbeDoneCard {part} />
{:else if toolInfo(tool)?.kind === "side"}
	<ToolCallCard {part} />
{:else if toolInfo(tool)?.kind === "practice"}
	<PracticeCards {part} />
{/if}
