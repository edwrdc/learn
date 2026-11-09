<script lang="ts">
	import type { Phase3 } from "@/src/session/model";
	let { phase, nodeCount }: { phase: Phase3; nodeCount?: number } = $props();
	const CHIP_LABEL: Record<Phase3, string> = { probe: "Probing", plan: "Planning", teach: "Teaching" };
	const label = $derived(phase === "plan" && nodeCount ? `Plan · ${nodeCount} node${nodeCount === 1 ? "" : "s"}` : CHIP_LABEL[phase]);
</script>

{#if phase !== "probe"}
	<div class="my-4 flex w-full items-center gap-3" data-testid={`phase-divider-${phase}`}>
		<span class="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden="true"></span>
		<span class="rounded-full border border-border/80 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
		<span class="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden="true"></span>
	</div>
{/if}
