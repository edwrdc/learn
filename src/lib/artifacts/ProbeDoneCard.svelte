<script lang="ts">
	import { ClipboardCheck } from "@lucide/svelte";
	import { parseProbeDoneInput, type ProbeDoneResult } from "@/src/session/model";

	let { part }: { part: { input?: unknown; output?: unknown; state?: unknown } } = $props();
	const output = $derived(part.output as ProbeDoneResult | undefined);
	const state = $derived(typeof part.state === "string" ? part.state : "");
	const input = $derived(parseProbeDoneInput(part.input));
	const assessment = $derived(input?.assessment);
	const strands = $derived(assessment && Array.isArray(assessment.strands) ? assessment.strands : null);
</script>

<div data-testid="probe-done-card" class="my-3 rounded-xl border bg-card/60 p-3">
	<div class="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
		<ClipboardCheck class="size-3.5 text-primary" />
		Probe concluded — your assessment
	</div>
	{#if output && !output.ok}
		<p class="text-sm text-muted-foreground">The prober retried: {output.error}</p>
	{:else if state === "output-error"}
		<p class="text-sm text-muted-foreground">The assessment was malformed — the prober retried with a corrected one.</p>
	{:else if strands}
		<div class="space-y-2">
			{#each strands as strand, i (i)}
				<div class="rounded-lg bg-background/60 px-3 py-2">
					<div class="text-sm font-medium">{strand.strand}</div>
					<div class="mt-0.5 text-sm text-muted-foreground">{strand.assessment}</div>
				</div>
			{/each}
			{#if assessment?.summary}<p class="px-1 text-sm text-muted-foreground">{assessment.summary}</p>{/if}
		</div>
	{:else}
		<p class="text-sm text-muted-foreground">Writing the assessment…</p>
	{/if}
</div>
