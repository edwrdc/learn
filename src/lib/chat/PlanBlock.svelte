<script lang="ts">
	import type { PlanBlockData, PlanNodeStatus } from "@/src/core";
	import { hint } from "$lib/hint";
	import PlanDiagram from "./PlanDiagram.svelte";
	import { GRAPH_PAD, TEXT_CAP_SCALE } from "./plan-layout";

	let { data, onOpen }: { data: PlanBlockData; onOpen: () => void } = $props();
	let seq = 0;
	const markerId = `plan-block-${++seq}`;
	const statusMap = $derived(new Map(data.nodes.map((n) => [n.id, n.status] as const)));
	const statusOf = (id: string): PlanNodeStatus => statusMap.get(id) ?? "upcoming";
</script>

<button
	type="button"
	data-testid="plan-block-full"
	aria-label="Open the full plan"
	onclick={onOpen}
	{@attach hint("Open the full plan", { side: "bottom" })}
	class="block w-full text-left"
>
	<PlanDiagram nodes={data.nodes} edges={data.edges} {statusOf} {markerId} pad={GRAPH_PAD} textCapScale={TEXT_CAP_SCALE} monochrome />
</button>
