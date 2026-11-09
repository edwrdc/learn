<script lang="ts">
	import type { PlanNodeStatus } from "@/src/session/model";
	import {
		ARROW_HEAD, GLOW_BLUR, GLOW_MARGIN, HEAD_W, LINE_H, NODE_H, NODE_W_MIN, STROKE_W,
		blockLayout, edgePathD, wrapTitle, type LayoutNode,
	} from "./plan-layout";

	let {
		nodes,
		edges,
		statusOf,
		glowId,
		markerId,
		pad: padUnits,
		textCapScale,
		naturalSize,
		monochrome,
		fill,
	}: {
		nodes: readonly LayoutNode[];
		edges: ReadonlyArray<{ from: string; to: string }>;
		statusOf: (id: string) => PlanNodeStatus;
		glowId?: string | null;
		markerId: string;
		pad?: number;
		textCapScale?: number;
		naturalSize?: boolean;
		monochrome?: boolean;
		fill?: boolean;
	} = $props();

	const BOX: Record<PlanNodeStatus, string> = {
		visited: "fill-background/50 stroke-white",
		current: "fill-background/50 stroke-white",
		upcoming: "fill-card stroke-border",
	};
	const TEXT: Record<PlanNodeStatus, string> = {
		visited: "fill-white text-xs",
		current: "fill-white text-xs font-medium",
		upcoming: "fill-muted-foreground/80 text-xs",
	};

	const layout = $derived(blockLayout(nodes, edges));
	const pad = $derived(padUnits ?? 0);
	const w = $derived(Math.max(layout.width, 1));
	const h = $derived(Math.max(layout.height, 1));
	const ox = $derived(layout.originX);
	const oy = $derived(layout.originY);
	const vbW = $derived(w + 2 * pad);
	const vbH = $derived(h + 2 * pad);
	const HEAD_H = 16 * (STROKE_W / 1.5);
</script>

<svg
	viewBox={`${ox - pad} ${oy - pad} ${vbW} ${vbH}`}
	class="block {fill ? 'h-full w-full' : `h-auto${naturalSize ? '' : ' w-full'}`}{textCapScale ? ' mx-auto' : ''}"
	style="font-family: var(--font-prose);{textCapScale
		? `max-width: ${Math.round(vbW * textCapScale * 100) / 100}px;`
		: naturalSize
			? `width: ${vbW}px;`
			: ''}"
	role="img"
	aria-label="Plan diagram"
>
	<defs>
		<marker id={markerId} viewBox="0 0 50.2 104" refX={27.2} refY={52} markerWidth={HEAD_W} markerHeight={HEAD_H} markerUnits="userSpaceOnUse" orient="auto">
			<path d={ARROW_HEAD} class="fill-white" />
		</marker>
		<marker id={`${markerId}-dim`} viewBox="0 0 50.2 104" refX={27.2} refY={52} markerWidth={HEAD_W} markerHeight={HEAD_H} markerUnits="userSpaceOnUse" orient="auto">
			<path d={ARROW_HEAD} class="fill-border" />
		</marker>
		<filter id={`${markerId}-glow`} x="-60%" y="-60%" width="220%" height="220%">
			<feGaussianBlur stdDeviation={GLOW_BLUR} />
		</filter>
	</defs>
	{#each edges as edge (`${edge.from}->${edge.to}`)}
		{@const pts = layout.edgePts.get(`${edge.from}->${edge.to}`)}
		{#if pts}
			{@const tx = layout.x.get(edge.to)}
			{@const ty = layout.y.get(edge.to)}
			{@const target = tx !== undefined && ty !== undefined ? { x: tx, y: ty, w: layout.nodeW.get(edge.to) ?? NODE_W_MIN, h: layout.nodeH.get(edge.to) ?? NODE_H } : undefined}
			{@const dim = !monochrome && (statusOf(edge.from) === "upcoming" || statusOf(edge.to) === "upcoming")}
			<path d={edgePathD(pts, target)} class={dim ? "fill-none stroke-border" : "fill-none stroke-white"} stroke-width={STROKE_W} marker-end={`url(#${markerId}${dim ? "-dim" : ""})`} />
		{/if}
	{/each}
	{#each nodes as node (node.id)}
		{@const status = statusOf(node.id)}
		{@const glow = node.id === glowId && !monochrome}
		{@const lines = wrapTitle(node.title)}
		{@const h = layout.nodeH.get(node.id) ?? NODE_H}
		{@const w = layout.nodeW.get(node.id) ?? NODE_W_MIN}
		{@const y0 = (h - lines.length * LINE_H) / 2 + 10}
		<g transform={`translate(${layout.x.get(node.id) ?? 0}, ${layout.y.get(node.id) ?? 0})`} data-testid={`plan-node-${node.id}`} data-status={status}>
			<rect width={w} height={h} class={monochrome ? "fill-card stroke-white" : BOX[status]} stroke-width={STROKE_W} />
			{#if glow}
				<rect x={-GLOW_MARGIN} y={-GLOW_MARGIN} width={w + 2 * GLOW_MARGIN} height={h + 2 * GLOW_MARGIN} class="fill-yellow-400/25" filter={`url(#${markerId}-glow)`} />
			{/if}
			{#each lines as line, i (i)}
				<text x={w / 2} y={y0 + i * LINE_H} text-anchor="middle" class={monochrome ? "text-xs fill-foreground" : TEXT[status]}>{line}</text>
			{/each}
		</g>
	{/each}
</svg>
