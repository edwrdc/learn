<script lang="ts">
	import Divider from "$lib/ui/Divider.svelte";
	import type { Phase3 } from "@/src/session/model";
	let { phase }: { phase: Phase3 } = $props();
	const CHIP_LABEL: Record<Phase3, string> = { probe: "Probing", plan: "Planning", teach: "Teaching" };
</script>

{#if phase !== "probe"}
	<Divider label={CHIP_LABEL[phase]} testid={`phase-divider-${phase}`} />
{/if}
