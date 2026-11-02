<script lang="ts">
	import PracticeMetadata from "./PracticeMetadata.svelte";
	import type { ArtifactPartProps } from "@/src/core";
	import Markdown from "$lib/markdown/Markdown.svelte";
	import ThinkingBlock from "./ThinkingBlock.svelte";

	const OUTCOME_LABEL: Record<string, string> = {
		solved: "Solved",
		solvedWithHints: "Solved with hints",
		movedOn: "Moved on",
		surrendered: "Surrendered",
		dismissed: "Dismissed",
	};
	const OUTCOME_CHIP: Record<string, string> = {
		solved: "bg-green-500/15 text-green-500",
		solvedWithHints: "bg-amber-500/15 text-amber-500",
		movedOn: "bg-muted text-muted-foreground",
		surrendered: "bg-red-500/15 text-red-500",
		dismissed: "bg-muted text-muted-foreground",
	};

	let { part }: { part: ArtifactPartProps["part"] } = $props();

	const isProblem = $derived(part.type === "tool-problem");
	const input = $derived((part.input ?? {}) as Record<string, unknown>);
	const outcome = $derived(typeof input.outcome === "string" ? input.outcome : "");
	const verdict = $derived(typeof input.verdict === "string" ? input.verdict : "");
	const reveal = $derived(
		typeof part.reveal === "string"
			? part.reveal
			: typeof input.solutionReveal === "string"
				? input.solutionReveal
				: "",
	);
	const statement = $derived(typeof input.statement === "string" ? input.statement : "");
</script>

{#if isProblem}
	<div data-testid="problem-card" class="lh-card-enter my-1 rounded-xl border bg-card p-4">
		<div class="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Problem</div>
		<div class="lh-prose text-[15px]"><Markdown text={statement} tool /></div>
	</div>
{:else if outcome === "dismissed"}
	<div data-testid="conclude-card" class="my-1 px-1 text-sm text-muted-foreground/70">Problem dismissed.</div>
{:else}
	<div data-testid="conclude-card" class="lh-card-enter relative my-1 rounded-xl border bg-card p-4">
		<div class="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
			Concluded
			{#if OUTCOME_LABEL[outcome] && outcome !== "dismissed"}
				<span class="rounded px-1.5 py-0.5 {OUTCOME_CHIP[outcome] ?? OUTCOME_CHIP.movedOn}">{OUTCOME_LABEL[outcome]}</span>
			{/if}
		</div>
		{#if verdict.length > 0}
			<div class="text-sm text-foreground/50"><Markdown text={verdict} tool /></div>
		{/if}
		{#if reveal.length > 0}
			<div class="my-3 border-t"></div>
			<div>
				<div class="mb-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Model solution</div>
				<div class="lh-prose text-[15px]"><Markdown text={reveal} tool /></div>
			</div>
		{/if}
		<PracticeMetadata conclude={input} problem={(part.problemInput ?? {}) as { mode?: unknown; target?: unknown }} />
	</div>
{/if}
