<script lang="ts">
	import type { ArtifactPartProps } from "@/src/session/model";
import type { JobRecord } from "@/src/jobs/model";
	import DispatchCard from "./DispatchCard.svelte";
	import JobCards from "./JobCards.svelte";
	import ToolCallCard from "./ToolCallCard.svelte";
	import ProbeDoneCard from "./ProbeDoneCard.svelte";
	import PracticeCards from "$lib/chat/PracticeCards.svelte";

	let { part, jobs }: { part: ArtifactPartProps["part"]; jobs: JobRecord[] } = $props();
	const tool = $derived(part.type.replace(/^tool-/, ""));
</script>

{#if tool === "research" || tool === "pdf"}
	<JobCards {part} {jobs} />
{:else if tool === "demo"}
	<DispatchCard toolCallId={part.toolCallId} kind="demo" {jobs} />
{:else if tool === "visual"}
	<DispatchCard toolCallId={part.toolCallId} kind="visual" {jobs} />
{:else if tool === "probe_done"}
	<ProbeDoneCard {part} />
{:else if ["read", "ls", "find", "grep", "list_sessions", "list_propositions"].includes(tool)}
	<ToolCallCard {part} />
{:else if tool === "problem" || tool === "conclude"}
	<PracticeCards {part} />
{/if}
