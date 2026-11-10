<script lang="ts">
	import PracticeMetadata from "./PracticeMetadata.svelte";
	import { outcomeLabel, PRACTICE_PROBLEM_TOOL, type ArtifactPartProps, type PracticeOutcome } from "@/src/session/model";
	import Markdown from "$lib/markdown/Markdown.svelte";

	const OUTCOME_CHIP: Record<PracticeOutcome, string> = {
		solved: "bg-green-500/15 text-green-500",
		solvedWithHints: "bg-amber-500/15 text-amber-500",
		movedOn: "bg-muted text-muted-foreground",
		surrendered: "bg-red-500/15 text-red-500",
		dismissed: "bg-muted text-muted-foreground",
	};

	let { part }: { part: ArtifactPartProps["part"] } = $props();

	const isProblem = $derived(part.type === `tool-${PRACTICE_PROBLEM_TOOL}`);
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
	const chip = $derived(Object.hasOwn(OUTCOME_CHIP, outcome) ? OUTCOME_CHIP[outcome as PracticeOutcome] : null);
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
			{#if chip}
				<span class="rounded px-1.5 py-0.5 {chip}">{outcomeLabel(outcome)}</span>
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
