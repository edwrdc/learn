<script lang="ts">
	import Divider from "$lib/ui/Divider.svelte";
	import { plural } from "$lib/format";
	import type { Phase3 } from "@/src/session/model";
	let { phase, nodeCount }: { phase: Phase3; nodeCount?: number } = $props();
	const CHIP_LABEL: Record<Phase3, string> = { probe: "Probing", plan: "Planning", teach: "Teaching" };
	const label = $derived(phase === "plan" && nodeCount ? `Plan · ${plural(nodeCount, "node")}` : CHIP_LABEL[phase]);
</script>

{#if phase !== "probe"}
	<Divider {label} testid={`phase-divider-${phase}`} />
{/if}
