<script lang="ts">
	import { picksFor, type GraphContextPick } from "@/src/session/model";
	import { dismissLayer } from "$lib/ui/layer";
	import { now } from "$lib/state/now.svelte";
	import { emitAppEvent, onAppEvent, onKeyAction } from "$lib/events";
	import { onDestroy, onMount } from "svelte";
	import { FileText, ListTree, Loader2, Search, Settings, Upload, Waypoints } from "@lucide/svelte";
	import { ARROW_LENGTH_LADDER, CHARGE_RANGE, CLUSTER_LABEL_SIZE_LADDER, CLUSTER_PULL_RANGE, DEPTH_BASE_RADIUS_RANGE, DEPTH_SPACING_RANGE, DEPTH_STRENGTH_RANGE, EDGE_WIDTH_LADDER, GRAVITY_RANGE, LABEL_SIZE_LADDER, LABEL_ZOOM_LADDER, LINK_DISTANCE_RANGE, LINK_STRENGTH_RANGE, NODE_SIZE_LADDER, REGION_BITMAP_OPTIONS, REGION_BLUR_LADDER, REGION_DILATION_LADDER, REGION_EDGE_ALPHA_LADDER, VELOCITY_DECAY_RANGE, fromLadderPosition, fromOffSliderPosition, fromSliderPosition, incrementalLayout, labelZoomDisplay, sanitizeRenderSettings, snapToLadder, toLadderPosition, toOffSliderPosition, toSliderPosition, type ExtractionRunView, type GraphNode, type GraphSnapshot } from "@/src/graph/model";
import { propositionSessionHref, type GraphCostSummary } from "@/src/session/model";
	import { GraphCanvasRenderer, type GraphRenderSettings } from "./graph-canvas.ts";
	import { cameraSaver, readCamera } from "./graph-camera";
	import { displayCostTotals, isNodeVisible, renameSessionsPatch, seedMissingNodePositions } from "./graph-view";
	import { serverEvents } from "$lib/state/server-events";
	import { settings as userSettings } from "$lib/state/settings.svelte";
	import { fetchExtractionRuns, fetchGraph, fetchGraphCosts, savePositions } from "$lib/api/graph";
	import { saveSettingsSection } from "$lib/api/settings";
	import { hint } from "$lib/hint";
	import MenuShell from "$lib/ui/MenuShell.svelte";
	import { formatTokens } from "$lib/format";
	import { goto } from "$app/navigation";
	import ChainTableOverlay from "./ChainTableOverlay.svelte";
	import DeleteNodeDialog from "./DeleteNodeDialog.svelte";
	import NotesImport from "./NotesImport.svelte";


	let { chainSelectOpen = false, practiceSelection, onPracticeSelectionChange, onChainSelectClose }: {
		chainSelectOpen?: boolean;
		practiceSelection?: ReadonlySet<string>;
		onPracticeSelectionChange?: (nodes: GraphContextPick[]) => void;
		onChainSelectClose?: () => void;
	} = $props();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let container = $state<HTMLDivElement | null>(null);
	let card = $state<HTMLDivElement | null>(null);
	let snapshot = $state<GraphSnapshot | null>(null);
	let selected = $state<{ node: GraphNode; sourceIds: string[]; anchor: { x: number; y: number } } | null>(null);
	let query = $state("");
	/** This view's edits win over the saved record until the page reloads. */
	let localRender = $state<GraphRenderSettings | null>(null);
	const settings = $derived(localRender ?? sanitizeRenderSettings(userSettings.record?.graphRender));
	let renderer = $state.raw<GraphCanvasRenderer | null>(null);
	let rendererReady = $state(false);
	let fitted = false;
	let positions: Map<string, { x: number; y: number }> | null = null;
	let refreshTick = $state(0);
	let chainsOpen = $state(false);
	let ctxNode = $state<{ id: string; name: string; x: number; y: number } | null>(null);
	let ctxAnchor = $state<HTMLDivElement | null>(null);
	let deleting = $state<{ id: string; name: string }[] | null>(null);
	let pipelineRuns = $state<ExtractionRunView[]>([]);
	let costs = $state<GraphCostSummary | null>(null);
	let searchInput = $state<HTMLInputElement | null>(null);
	let costOpen = $state(false);
	let settingsOpen = $state(false);
	let costAnchor = $state<HTMLDivElement | null>(null);
	let settingsAnchor = $state<HTMLDivElement | null>(null);
	let labelTick = $state(0);
	let rowIds = new Set<string>();
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let statusDebounce: ReturnType<typeof setTimeout> | undefined;

	const isEmpty = $derived(snapshot === null || snapshot.nodes.length === 0);
	const visibleIds = $derived.by(() => {
		const set = new Set<string>();
		if (!snapshot) return set;
		for (const node of snapshot.nodes) {
			if (isNodeVisible(node, query)) set.add(node.id);
		}
		return set;
	});

	function tokenHex(name: string): string {
		const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
		if (!value) return "#888888";
		const probe = document.createElement("canvas");
		probe.width = 1;
		probe.height = 1;
		const ctx = probe.getContext("2d");
		if (!ctx) return "#888888";
		ctx.fillStyle = value;
		ctx.fillRect(0, 0, 1, 1);
		const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
		return `#${[r!, g!, b!].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
	}


	async function readGraph() {
		try {
			snapshot = await fetchGraph();
		} catch (error) {
			console.error("[graph] load failed:", error);
		}
	}
	async function readCosts() {
		try {
			costs = await fetchGraphCosts();
		} catch (error) {
			console.error("[graph] costs load failed:", error);
		}
	}
	async function readStatus() {
		try {
			const runs = await fetchExtractionRuns();
			pipelineRuns = runs;
			const ids = new Set(runs.map((run) => run.id));
			if ([...rowIds].some((id) => !ids.has(id))) refreshTick += 1;
			rowIds = ids;
		} catch (error) {
			console.error("[graph] status load failed:", error);
		}
	}
	function changeSettings(update: (current: GraphRenderSettings) => GraphRenderSettings) {
		const next = update(settings);
		localRender = next;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			saveSettingsSection("graphRender", next)
				.then((record) => userSettings.set(record))
				.catch((error) => console.error("[graph] display settings not saved:", error));
		}, 400);
	}

	function dispatchCostsRefresh() {
		if ([...rowIds].some((id) => !pipelineRuns.some((run) => run.id === id))) void readCosts();
	}

	function openSession(id: string) {
		void goto(`/chat/${id}`);
	}

	$effect(() => {
		void refreshTick;
		void readGraph();
	});
	$effect(() => {
		if (chainSelectOpen) chainsOpen = true;
	});

	$effect(() => {
		void readStatus();
		void readCosts();
		const offs = [
			serverEvents.subscribe("activity-changed", () => {
				clearTimeout(statusDebounce);
				statusDebounce = setTimeout(() => void readStatus(), 250);
			}),
			serverEvents.onResync(() => {
				void readStatus();
				void readGraph();
			}),
		];
		const onRevision = () => {
			refreshTick += 1;
			void readCosts();
		};
		const onRenamed = (detail: { id: string; title: string }) => {
			if (!snapshot) return;
			renameSessionsPatch(snapshot, detail.id, detail.title);
			labelTick += 1;
			renderer?.setClusterLabels(new Map([[detail.id, detail.title]]));
		};
		const onFind = () => searchInput?.focus();
		offs.push(onAppEvent("graph-revision", onRevision), onAppEvent("chat-renamed", onRenamed), onKeyAction("find", onFind));
		return () => {
			for (const off of offs) off();
			clearTimeout(statusDebounce);
			clearTimeout(saveTimer);
		};
	});

	$effect(() => {
		void pipelineRuns;
		dispatchCostsRefresh();
	});

	$effect(() => {
		void selected;
		if (!selected || !card || !container) return;
		const width = card.offsetWidth;
		const height = card.offsetHeight;
		const margin = 8;
		const gap = 12;
		const left = Math.min(Math.max(selected.anchor.x - width / 2, margin), Math.max(container.clientWidth - width - margin, margin));
		let top = selected.anchor.y + gap;
		if (top + height > container.clientHeight - margin) top = Math.max(selected.anchor.y - gap - height, margin);
		card.style.left = `${left}px`;
		card.style.top = `${top}px`;
		card.style.visibility = "visible";
	});

	$effect(() => {
		if (!snapshot || snapshot.nodes.length === 0) return;
		const ledger = snapshot.positions;
		if (ledger) {
			const map = new Map<string, { x: number; y: number }>();
			for (const node of snapshot.nodes) {
				const p = ledger[node.id];
				if (p) map.set(node.id, { x: p.x, y: p.y });
			}
			if (map.size > 0) {
				positions = seedMissingNodePositions(snapshot.nodes, map);
				return;
			}
		}
		positions = incrementalLayout(snapshot.nodes, snapshot.edges, new Map());
	});

	$effect(() => {
		if (isEmpty || !canvas) {
			renderer = null;
			rendererReady = false;
			return;
		}
		const camera = cameraSaver();
		const instance = new GraphCanvasRenderer(
			canvas!,
			{
				onSelect: (nodeId, position) => {
					const node = snapshot?.nodes.find((n) => n.id === nodeId);
					if (!snapshot || !node) return;
					selected = { node, sourceIds: snapshot.nodeSessions[node.id] ?? [], anchor: position };
				},
				onStageClick: () => (selected = null),
				onContext: (nodeId, position) => {
					if (nodeId === null) {
						ctxNode = null;
						return;
					}
					const node = snapshot?.nodes.find((n) => n.id === nodeId);
					if (node) ctxNode = { id: node.id, name: node.name, x: position.x, y: position.y };
				},
				onCameraMove: (transform) => {
					selected = null;
					ctxNode = null;
					camera.save(transform);
				},
				onCommit: (next) => {
					savePositions(next).catch((error) => console.error("[graph] positions not saved:", error));
				},
			},
			readCamera(),
		);
		renderer = instance;
		rendererReady = true;
		return () => {
			renderer = null;
			rendererReady = false;
			fitted = false;
			camera.flush();
			instance.destroy();
		};
	});

	$effect(() => {
		if (!rendererReady || !renderer || !snapshot || !positions || snapshot.nodes.length === 0) return;
		renderer.setData({
			nodes: snapshot.nodes.map((node) => ({ id: node.id, x: positions!.get(node.id)?.x ?? 0, y: positions!.get(node.id)?.y ?? 0, label: node.name })),
			edges: snapshot.edges.map((edge) => ({ from: edge.from, to: edge.to })),
			logicalEdges: snapshot.logicalEdges.map((edge) => ({ from: edge.from, to: edge.to })),
			impLinks: snapshot.impLinks,
			clusters: snapshot.clusters.map((cluster) => ({ id: cluster.id, label: cluster.label, members: cluster.members })),
			colors: { node: tokenHex("--primary"), edge: tokenHex("--ring"), label: tokenHex("--muted-foreground"), hoverText: tokenHex("--foreground") },
			fontFamily: getComputedStyle(document.body).fontFamily,
		});
		if (!fitted) {
			const target = renderer;
			requestAnimationFrame(() => {
				target.fit();
				fitted = true;
			});
		}
	});

	$effect(() => {
		if (!rendererReady) return;
		renderer?.setSettings(settings);
	});
	$effect(() => {
		if (!rendererReady) return;
		renderer?.setVisible(query.trim() ? visibleIds : null);
		if (selected && !visibleIds.has(selected.node.id)) selected = null;
	});
	$effect(() => {
		if (!rendererReady) return;
		renderer?.setRegionTuning(settings.regions);
	});
	$effect(() => {
		if (!rendererReady) return;
		renderer?.setPhysicsTuning(settings.physics);
	});

	$effect(() => {
		if (!costOpen && !settingsOpen) return;
		return dismissLayer(
			() => {
				costOpen = false;
				settingsOpen = false;
			},
			{ inside: () => [costAnchor, settingsAnchor], menus: true },
		);
	});

	onMount(() => {
	});

	const costTotals = $derived(costs ? displayCostTotals(costs) : { totalDollars: 0, unpricedRuns: 0 });
	const displayTotal = $derived(costTotals.totalDollars);
	const unpricedRuns = $derived(costTotals.unpricedRuns);
	const stageRows = $derived(
		costs
			? ([
					["Extraction", costs.stages.extraction],
					["Audit", costs.stages.audit],
				] as Array<[string, GraphCostSummary["stages"]["extraction"]]>)
			: [],
	);

	function settingDisplay(value: number): string {
		return `${value >= 1 ? Math.round(value * 10) / 10 : Math.round(value * 100) / 100}`;
	}
</script>

<div class="relative h-full w-full">
	{#if isEmpty}
		<div class="flex h-full w-full items-center justify-center px-4">
			<div class="flex flex-col items-center gap-3 text-center text-muted-foreground">
				<Waypoints class="size-10 opacity-40" strokeWidth={1.25} />
				<div class="text-lg font-medium text-foreground">Knowledge graph</div>
				<p class="max-w-sm text-sm">Start a session or import notes to build your graph.</p>
			</div>
		</div>
	{:else}
		<div bind:this={container} class="relative h-full w-full">
			<canvas bind:this={canvas} class="block h-full w-full touch-none"></canvas>
			{#if ctxNode}
				<div bind:this={ctxAnchor} style="position:absolute;left:{ctxNode.x}px;top:{ctxNode.y}px;width:0;height:0"></div>
			{/if}
		</div>
	{/if}

	{#if ctxNode}
		<MenuShell anchor={ctxAnchor} testid="node-context-menu" preferredSide="down" menuClass="flex w-fit flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl">
			<button type="button" data-testid="ctx-node-delete" onclick={() => { deleting = [{ id: ctxNode!.id, name: ctxNode!.name }]; ctxNode = null; }} class="flex items-center rounded-lg px-2.5 py-1.5 text-left text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground">Delete</button>
		</MenuShell>
	{/if}

	<DeleteNodeDialog nodes={deleting} onClose={() => (deleting = null)} onDeleted={(ids, revision) => {
		deleting = null;
		if (selected && ids.includes(selected.node.id)) selected = null;
		emitAppEvent("graph-revision", { graphRevision: revision });
	}} />

	<div class="lh-no-drag lh-wco-floating absolute right-2 top-2 z-10 flex max-w-[calc(100%-5.5rem)] flex-col items-end gap-2">
		<div class="relative z-20 flex min-w-0 items-start gap-2">
			{#if !isEmpty}
				<div class="graph-chrome-fade-in w-56 min-w-0 shrink rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
					<div class="relative">
						<Search class="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<input bind:this={searchInput} value={query} oninput={(event) => (query = (event.currentTarget as HTMLInputElement).value)} placeholder="Search nodes…" aria-label="Search nodes" spellcheck={false} {@attach hint("Search nodes", { action: "find", side: "bottom" })} class="h-7 w-full rounded-lg border bg-background pl-8 text-xs outline-none placeholder:text-muted-foreground focus:border-ring" />
					</div>
					{#if snapshot && visibleIds.size === 0 && query.trim() !== ""}
						<div class="px-1.5 pt-1 text-[11px] text-muted-foreground">No matching nodes.</div>
					{/if}
				</div>
				<div class="graph-chrome-fade-in shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
					<button type="button" onclick={() => (chainsOpen = true)} data-testid="open-chain-table" {@attach hint("Every reasoning chain", { side: "bottom" })} class="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"><ListTree class="size-3" />Chains</button>
				</div>
			{/if}
			<div class="shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
				<NotesImport onFinished={() => { refreshTick += 1; void readCosts(); }} />
			</div>
			{#if !isEmpty}
				<div class="graph-chrome-fade-in shrink-0">
					<div bind:this={settingsAnchor} class="relative">
						<button type="button" aria-label="Graph display settings" aria-expanded={settingsOpen} onclick={() => (settingsOpen = !settingsOpen)} {@attach hint("Graph display settings", { side: "bottom" })} class="flex size-9 items-center justify-center rounded-xl border bg-card/85 shadow-lg backdrop-blur transition-colors hover:bg-accent {settingsOpen ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}"><Settings class="size-4" /></button>
						{#if settingsOpen}
							<div class="absolute right-0 top-full mt-2 flex max-h-[60vh] w-72 flex-col rounded-xl border bg-card/85 p-2.5 shadow-lg backdrop-blur">
								<div class="flex flex-col gap-2 overflow-y-auto pr-2.5">
									<label class="flex flex-col gap-1"><span class="flex items-center justify-between text-[11px] text-muted-foreground">Node size<span class="tabular-nums">{settingDisplay(settings.nodeSize)}</span></span><input type="range" min={0} max={100} step={10} value={toLadderPosition(settings.nodeSize, NODE_SIZE_LADDER)} oninput={(e) => changeSettings((cur) => ({ ...cur, nodeSize: fromLadderPosition(Number((e.currentTarget as HTMLInputElement).value), NODE_SIZE_LADDER) }))} class="h-1.5 w-full accent-primary" /></label>
									<label class="flex flex-col gap-1"><span class="flex items-center justify-between text-[11px] text-muted-foreground">Edge width<span class="tabular-nums">{settingDisplay(settings.edgeWidth)}</span></span><input type="range" min={0} max={100} step={10} value={toLadderPosition(settings.edgeWidth, EDGE_WIDTH_LADDER)} oninput={(e) => changeSettings((cur) => ({ ...cur, edgeWidth: fromLadderPosition(Number((e.currentTarget as HTMLInputElement).value), EDGE_WIDTH_LADDER) }))} class="h-1.5 w-full accent-primary" /></label>
									<label class="flex flex-col gap-1"><span class="flex items-center justify-between text-[11px] text-muted-foreground">Arrowhead size<span class="tabular-nums">{settingDisplay(settings.arrowLength)}</span></span><input type="range" min={0} max={100} step={10} value={toLadderPosition(settings.arrowLength, ARROW_LENGTH_LADDER)} oninput={(e) => changeSettings((cur) => ({ ...cur, arrowLength: fromLadderPosition(Number((e.currentTarget as HTMLInputElement).value), ARROW_LENGTH_LADDER) }))} class="h-1.5 w-full accent-primary" /></label>
									<label class="flex flex-col gap-1"><span class="flex items-center justify-between text-[11px] text-muted-foreground">Label size<span class="tabular-nums">{settingDisplay(settings.labelSize)}</span></span><input type="range" min={0} max={100} step={10} value={toLadderPosition(settings.labelSize, LABEL_SIZE_LADDER)} oninput={(e) => changeSettings((cur) => ({ ...cur, labelSize: fromLadderPosition(Number((e.currentTarget as HTMLInputElement).value), LABEL_SIZE_LADDER) }))} class="h-1.5 w-full accent-primary" /></label>
									<label class="flex flex-col gap-1"><span class="flex items-center justify-between text-[11px] text-muted-foreground">Labels until zoom<span class="tabular-nums">{labelZoomDisplay(settings.labelZoom)}</span></span><input type="range" min={0} max={100} step={10} value={toLadderPosition(settings.labelZoom, LABEL_ZOOM_LADDER)} oninput={(e) => changeSettings((cur) => ({ ...cur, labelZoom: fromLadderPosition(Number((e.currentTarget as HTMLInputElement).value), LABEL_ZOOM_LADDER) }))} class="h-1.5 w-full accent-primary" /></label>
									<div class="mt-1.5 flex flex-col gap-1.5 border-t pt-1.5">
										<span class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Regions</span>
										<label class="flex cursor-pointer items-center justify-between text-[11px] text-muted-foreground"><span>Background colors</span><input type="checkbox" checked={settings.regions.enabled} onchange={(e) => changeSettings((cur) => ({ ...cur, regions: { ...cur.regions, enabled: (e.currentTarget as HTMLInputElement).checked } }))} class="accent-primary" /></label>
										<label class="flex flex-col gap-1 {settings.regions.enabled ? '' : 'opacity-40'}"><span class="flex items-center justify-between text-[11px] text-muted-foreground">Dilation<span class="tabular-nums">{settingDisplay(settings.regions.dilation)}</span></span><input type="range" min={0} max={100} step={10} disabled={!settings.regions.enabled} value={toLadderPosition(settings.regions.dilation, REGION_DILATION_LADDER)} oninput={(e) => changeSettings((cur) => ({ ...cur, regions: { ...cur.regions, dilation: fromLadderPosition(Number((e.currentTarget as HTMLInputElement).value), REGION_DILATION_LADDER) } }))} class="h-1.5 w-full accent-primary" /></label>
										<label class="flex flex-col gap-1 {settings.regions.enabled ? '' : 'opacity-40'}"><span class="flex items-center justify-between text-[11px] text-muted-foreground">Blur<span class="tabular-nums">{settingDisplay(settings.regions.blur)}</span></span><input type="range" min={0} max={100} step={10} disabled={!settings.regions.enabled} value={toLadderPosition(settings.regions.blur, REGION_BLUR_LADDER)} oninput={(e) => changeSettings((cur) => ({ ...cur, regions: { ...cur.regions, blur: fromLadderPosition(Number((e.currentTarget as HTMLInputElement).value), REGION_BLUR_LADDER) } }))} class="h-1.5 w-full accent-primary" /></label>
										<label class="flex flex-col gap-1 {settings.regions.enabled ? '' : 'opacity-40'}"><span class="flex items-center justify-between text-[11px] text-muted-foreground">Edge alpha<span class="tabular-nums">{settingDisplay(settings.regions.edgeAlpha)}</span></span><input type="range" min={0} max={100} step={10} disabled={!settings.regions.enabled} value={toLadderPosition(settings.regions.edgeAlpha, REGION_EDGE_ALPHA_LADDER)} oninput={(e) => changeSettings((cur) => ({ ...cur, regions: { ...cur.regions, edgeAlpha: fromLadderPosition(Number((e.currentTarget as HTMLInputElement).value), REGION_EDGE_ALPHA_LADDER) } }))} class="h-1.5 w-full accent-primary" /></label>
										<label class="flex cursor-pointer items-center justify-between text-[11px] text-muted-foreground"><span>Cluster labels</span><input type="checkbox" checked={settings.clusterLabels} onchange={(e) => changeSettings((cur) => ({ ...cur, clusterLabels: (e.currentTarget as HTMLInputElement).checked }))} class="accent-primary" /></label>
										<label class="flex flex-col gap-1 {settings.clusterLabels ? '' : 'opacity-40'}"><span class="flex items-center justify-between text-[11px] text-muted-foreground">Cluster label size<span class="tabular-nums">{settingDisplay(settings.clusterLabelSize)}</span></span><input type="range" min={0} max={100} step={10} disabled={!settings.clusterLabels} value={toLadderPosition(settings.clusterLabelSize, CLUSTER_LABEL_SIZE_LADDER)} oninput={(e) => changeSettings((cur) => ({ ...cur, clusterLabelSize: fromLadderPosition(Number((e.currentTarget as HTMLInputElement).value), CLUSTER_LABEL_SIZE_LADDER) }))} class="h-1.5 w-full accent-primary" /></label>
									</div>
									<div class="mt-1.5 flex flex-col gap-1.5 border-t pt-1.5">
										<span class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Physics</span>
										<label class="flex flex-col gap-1"><span class="flex items-center justify-between text-[11px] text-muted-foreground">Cluster pull<span class="tabular-nums">{settings.physics.clusterPull <= 0 ? "off" : settingDisplay(settings.physics.clusterPull)}</span></span><input type="range" min={0} max={100} step={5} value={toOffSliderPosition(settings.physics.clusterPull, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max)} oninput={(e) => changeSettings((cur) => ({ ...cur, physics: { ...cur.physics, clusterPull: fromOffSliderPosition(Number((e.currentTarget as HTMLInputElement).value), CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max) } }))} class="h-1.5 w-full accent-primary" /></label>
										<label class="flex flex-col gap-1"><span class="flex items-center justify-between text-[11px] text-muted-foreground">Friction<span class="tabular-nums">{settingDisplay(settings.physics.velocityDecay)}</span></span><input type="range" min={0} max={100} step={5} value={toSliderPosition(settings.physics.velocityDecay, VELOCITY_DECAY_RANGE.min, VELOCITY_DECAY_RANGE.max)} oninput={(e) => changeSettings((cur) => ({ ...cur, physics: { ...cur.physics, velocityDecay: fromSliderPosition(Number((e.currentTarget as HTMLInputElement).value), VELOCITY_DECAY_RANGE.min, VELOCITY_DECAY_RANGE.max) } }))} class="h-1.5 w-full accent-primary" /></label>
									</div>
								</div>
							</div>
						{/if}
					</div>
				</div>
			{/if}
		</div>
		{#if costs && costs.runs.length > 0}
			<div bind:this={costAnchor} class="relative">
				<button type="button" aria-expanded={costOpen} onclick={() => (costOpen = !costOpen)} {@attach hint("Graph costs — click for details", { side: "bottom" })} class="rounded-lg px-2 py-1 text-xs tabular-nums transition-colors hover:bg-accent {costOpen ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}">${displayTotal.toFixed(2)}</button>
				{#if costOpen}
					<div class="absolute right-0 top-full mt-2 max-h-[60vh] overflow-y-auto">
						<div class="w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border bg-card/95 p-3 text-xs shadow-lg backdrop-blur">
							<div class="mb-2 flex items-baseline justify-between">
								<span class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Graph pipeline costs</span>
								<span class="text-foreground tabular-nums">${displayTotal.toFixed(2)}{#if unpricedRuns > 0}<span class="text-muted-foreground"> · {unpricedRuns} unpriced</span>{/if}</span>
							</div>
							<div class="flex flex-col gap-1">
								{#each stageRows as [label, stage] (label)}
									<div class="flex items-baseline justify-between gap-2 text-[11px]">
										<span class="shrink-0 text-muted-foreground">{label}</span>
										<span class="min-w-0 text-right tabular-nums">${stage.dollars.toFixed(3)}<span class="text-muted-foreground"> · {formatTokens(stage.tokens.inputTokens ?? 0)} in / {formatTokens(stage.tokens.outputTokens ?? 0)} out</span></span>
									</div>
								{/each}
							</div>
							<div class="mt-2 flex flex-col gap-0.5 border-t pt-2">
								{#each costs.runs as run (run.startedAt)}
									<div class="flex items-baseline justify-between gap-2 text-[11px]">
										<span class="min-w-0 flex-1 truncate text-muted-foreground"><span class="text-foreground/70">{run.title}</span></span>
										<span class="shrink-0 tabular-nums">{run.dollars === null ? "—" : `$${run.dollars.toFixed(3)}`}</span>
									</div>
								{/each}
							</div>
						</div>
					</div>
				{/if}
			</div>
		{/if}
		{#each pipelineRuns as run (run.id)}
			<div class="flex items-center gap-2 rounded-full border bg-card/85 px-3 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur">
				<Loader2 class="size-3.5 shrink-0 animate-spin" />
				<span class="capitalize">{run.phase}</span>
				<span class="max-w-48 truncate text-foreground">{run.title}</span>
				<span class="tabular-nums">{Math.max(0, Math.round((now() - run.startedAt) / 1000))}s</span>
			</div>
		{/each}
	</div>

	{#if selected && !isEmpty}
		<div bind:this={card} style="visibility:hidden;left:0;top:0" class="lh-no-drag absolute z-10 w-80 max-w-[calc(100%-1rem)] rounded-xl border bg-card p-4 text-left shadow-lg">
			<div class="text-sm font-medium leading-snug">{selected.node.name}</div>
			<div class="mt-1 text-xs leading-relaxed text-muted-foreground">{selected.node.statement}</div>
			{#if selected.sourceIds.length > 0}
				<div class="mt-3 flex flex-col gap-1">
					<div class="text-xs text-muted-foreground">Sessions</div>
					{#each selected.sourceIds as sourceId (sourceId)}
						{#if snapshot?.fileSources?.[sourceId] !== undefined}
							<div class="flex items-center gap-1.5"><FileText class="size-3.5 shrink-0 text-muted-foreground" /><span class="min-w-0 flex-1 truncate px-2 py-1.5 text-sm text-muted-foreground">{snapshot.fileSources[sourceId]}</span></div>
						{:else}
							<div class="flex items-center gap-1.5">
								<a href={propositionSessionHref(selected.node, sourceId)} class="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent" onclick={(event) => { event.preventDefault(); openSession(sourceId); }}>{snapshot?.sessions[sourceId] ?? sourceId}</a>
							</div>
						{/if}
					{/each}
				</div>
			{:else}
				<div class="mt-3 text-xs text-muted-foreground">No sessions recorded.</div>
			{/if}
		</div>
	{/if}

	<ChainTableOverlay
		open={chainsOpen && !isEmpty}
		nodes={snapshot?.propositions ?? []}
		chains={snapshot?.chains ?? []}
		sessions={snapshot?.sessions ?? {}}
		fileSources={snapshot?.fileSources ?? {}}
		onClose={() => { chainsOpen = false; onChainSelectClose?.(); }}
		selectMode={chainSelectOpen}
		controlledSelection={practiceSelection}
		onSelectionChange={(ids) => {
			onPracticeSelectionChange?.(picksFor(ids, snapshot?.propositions ?? []));
		}}
	/>
</div>
