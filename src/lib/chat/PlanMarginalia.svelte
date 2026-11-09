<script lang="ts">
	import { derivedNodeStatus, derivePlanStatuses, type PlanNodeStatus } from "@/src/session/model";
	import PlanDiagram from "./PlanDiagram.svelte";
	import { GRAPH_PAD, latestTree, TEXT_CAP_SCALE, type PopupMessage } from "./plan-layout";

	let { messages }: { messages: readonly PopupMessage[] } = $props();
	let seq = 0;
	const markerId = `plan-margin-${++seq}`;
	const MARGIN_PAD = GRAPH_PAD + 16;
	const tree = $derived(latestTree(messages));
	const statuses = $derived(tree ? derivePlanStatuses(tree, messages as Parameters<typeof derivePlanStatuses>[1]) : null);
	const statusOf = (id: string): PlanNodeStatus => (statuses ? derivedNodeStatus(statuses, id) : "upcoming");
</script>

{#if tree && tree.nodes.length > 0}
	<PlanDiagram nodes={tree.nodes} edges={tree.edges} {statusOf} glowId={statuses?.current ?? null} {markerId} pad={MARGIN_PAD} textCapScale={TEXT_CAP_SCALE} fill />
{/if}
