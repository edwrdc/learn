<script lang="ts">
	import { plural } from "$lib/format";
	import { Check, CircleX } from "@lucide/svelte";
	import { isJobFailure, type PdfResult, type ResearchResult, type SubagentArtifactData } from "@/src/jobs/model";
	import type { LhViewMessage } from "@/src/session/model";
	import DemoOutputCard from "./DemoOutputCard.svelte";
	import VisualOutputCard from "./VisualOutputCard.svelte";
	import ResearchBrief from "./ResearchBrief.svelte";

	let { message }: { message: LhViewMessage } = $props();
	const artifactPart = $derived(message.parts.find((p) => p.type === "data-subagent-artifact"));
	const data = $derived(artifactPart?.data as SubagentArtifactData | undefined);
	const aborted = $derived.by(() => {
		if (data) return undefined;
		return message.parts.find((p) => p.type === "data-subagent-aborted") as { data?: { kind?: string } } | undefined;
	});
</script>

{#if !data}
	{#if aborted?.data}
		<div data-testid="job-aborted-badge" class="flex items-center gap-2 text-xs text-muted-foreground">
			<CircleX class="size-3.5" />
			<span class="font-medium uppercase tracking-wide">{aborted.data.kind ?? "job"}</span>
			<span>aborted by the learner</span>
		</div>
	{:else}
		<div class="rounded-xl border bg-card p-4 text-sm text-muted-foreground">A sub-agent finished, but its result could not be displayed.</div>
	{/if}
{:else if data.kind === "research"}
	{#if isJobFailure(data.result)}
		<ResearchBrief output={data.result} kind="research" />
	{:else}
		<details data-testid="research-complete-badge" class="group w-full text-xs text-muted-foreground">
			<summary class="flex cursor-pointer select-none list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
				<Check class="size-3.5" />
				<span class="font-medium uppercase tracking-wide">Research</span>
				<span>complete</span>
				{#if (data.result as ResearchResult).sources.length > 0}
					<span>· {(data.result as ResearchResult).sources.length} sources</span>
				{/if}
				<span class="ml-1 text-xs text-muted-foreground/70 group-open:hidden">view brief</span>
				<span class="ml-1 hidden text-xs text-muted-foreground/70 group-open:inline">hide brief</span>
			</summary>
			<div class="mt-2"><ResearchBrief output={data.result} kind="research" /></div>
		</details>
	{/if}
{:else if data.kind === "pdf"}
	{#if isJobFailure(data.result)}
		<ResearchBrief output={data.result} kind="pdf" />
	{:else}
		<details data-testid="pdf-complete-badge" class="group w-full text-xs text-muted-foreground">
			<summary class="flex cursor-pointer select-none list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
				<Check class="size-3.5" />
				<span class="font-medium uppercase tracking-wide">PDF</span>
				<span>reading complete</span>
				{#if (data.result as PdfResult).pagesRead.length > 0}
					<span>· read {plural((data.result as PdfResult).pagesRead.length, "page")}</span>
				{/if}
				<span class="ml-1 text-xs text-muted-foreground/70 group-open:hidden">view brief</span>
				<span class="ml-1 hidden text-xs text-muted-foreground/70 group-open:inline">hide brief</span>
			</summary>
			<div class="mt-2"><ResearchBrief output={data.result} kind="pdf" /></div>
		</details>
	{/if}
{:else if data.kind === "demo"}
	<DemoOutputCard output={data.result} messageId={message.id} initialInverted={data.ui?.inverted ?? false} />
{:else if data.kind === "visual"}
	<VisualOutputCard output={data.result} messageId={message.id} initialInverted={data.ui?.inverted ?? false} />
{/if}
