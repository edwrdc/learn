<script lang="ts">
	import type { Phase3 } from "@/src/core";
	let { phase }: { phase: Phase3 } = $props();
	const CHIP_LABEL: Record<Phase3, string> = { probe: "Probing", plan: "Planning", teach: "Teaching" };
</script>

<span
	data-testid="phase-chip"
	data-phase={phase}
	aria-hidden="true"
	class="pointer-events-none flex shrink-0 select-none items-center text-xs font-medium uppercase tracking-wide text-muted-foreground"
>{CHIP_LABEL[phase]}</span>
