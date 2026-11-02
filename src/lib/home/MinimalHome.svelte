<script lang="ts">
	import { ListTree } from "@lucide/svelte";
	import type { ChatSummary, GraphCostSummary, GraphSnapshot } from "@/src/core";
	import { serverEvents } from "$lib/state/server-events";
	import { hint } from "$lib/hint";
	import ChainTableOverlay from "./ChainTableOverlay.svelte";
	import NotesImport from "./NotesImport.svelte";
	import { knowledgeEmpty, knowledgeLines, type KnowledgeCounts } from "./minimal-home";

	let { chainSelectOpen = false, practiceSelection, onPracticeSelectionChange, onChainSelectClose }: {
		chainSelectOpen?: boolean;
		practiceSelection?: ReadonlySet<string>;
		onPracticeSelectionChange?: (nodes: { id: string; name: string; statement: string }[]) => void;
		onChainSelectClose?: () => void;
	} = $props();

	let snapshot = $state<GraphSnapshot | null>(null);
	let costs = $state<GraphCostSummary | null>(null);
	let chats = $state<ChatSummary[]>([]);
	let chainsOpen = $state(false);

	function readState() {
		fetch("/api/graph").then((r) => r.json() as Promise<GraphSnapshot>).then((value) => (snapshot = value)).catch(() => {});
		fetch("/api/graph/costs").then((r) => r.json() as Promise<GraphCostSummary>).then((value) => (costs = value)).catch(() => {});
		fetch("/api/chats").then((r) => r.json() as Promise<{ chats: ChatSummary[] }>).then((body) => (chats = body.chats)).catch(() => {});
	}

	$effect(() => {
		readState();
	});
	$effect(() => {
		if (chainSelectOpen) chainsOpen = true;
	});
	$effect(() => {
		const offs = [serverEvents.subscribe("chats-changed", readState), serverEvents.subscribe("activity-changed", readState), serverEvents.onResync(readState)];
		return () => {
			for (const off of offs) off();
		};
	});

	const teachSessions = $derived(chats.filter((chat) => chat.kind === "teach").length);
	const practiceSessions = $derived(chats.filter((chat) => chat.kind === "practice").length);
	const propositions = $derived(snapshot?.propositions.length ?? 0);
	const chains = $derived(snapshot?.chains.length ?? 0);
	const importedNotes = $derived(Object.keys(snapshot?.fileSources ?? {}).length);
	const counts = $derived<KnowledgeCounts>({ propositions, chains, teachSessions, practiceSessions, importedNotes });
	const lines = $derived(knowledgeLines(counts));
	const empty = $derived(knowledgeEmpty(counts));
</script>

<div class="relative h-full">
	<div class="pointer-events-none flex h-full items-center justify-center pb-40">
		<div data-testid="knowledge-summary" class="flex flex-col items-center text-center">
			{#each ["graph", "sessions", "notes"] as block, blockIndex (block)}
				{#if blockIndex > 0}<div class="h-4" aria-hidden="true"></div>{/if}
				<div class={block === "notes" ? "" : "flex flex-col gap-1"}>
					{#each lines.filter((line) => line.block === block) as line (line.text)}
						<p class="font-ui text-sm text-muted-foreground">{line.text}</p>
					{/each}
				</div>
			{/each}
			{#if empty}
				<p class="pt-2 font-ui text-xs text-muted-foreground/70">Nothing here yet — import notes to begin building the graph.</p>
			{/if}
		</div>
	</div>

	<div class="lh-no-drag lh-wco-floating absolute right-2 top-2 z-10 flex max-w-[calc(100%-5.5rem)] flex-col items-end gap-2">
		<div class="flex min-w-0 items-start gap-2">
			<div class="graph-chrome-fade-in shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
				<button type="button" onclick={() => (chainsOpen = true)} data-testid="open-chain-table" {@attach hint("Every reasoning chain", { side: "bottom" })} class="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"><ListTree class="size-3" />Chains</button>
			</div>
			<div class="shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
				<NotesImport onFinished={readState} />
			</div>
		</div>
		{#if costs && costs.runs.length > 0}
			<span class="rounded-lg px-2 py-1 text-xs tabular-nums text-muted-foreground">${(costs.stages.extraction.dollars + costs.stages.audit.dollars).toFixed(2)}</span>
		{/if}
	</div>

	<ChainTableOverlay
		open={chainsOpen && (snapshot?.propositions.length ?? 0) > 0}
		nodes={snapshot?.propositions ?? []}
		chains={snapshot?.chains ?? []}
		sessions={snapshot?.sessions ?? {}}
		fileSources={snapshot?.fileSources ?? {}}
		onClose={() => { chainsOpen = false; onChainSelectClose?.(); }}
		selectMode={chainSelectOpen}
		controlledSelection={practiceSelection}
		onSelectionChange={(ids) => {
			const propositionsList = snapshot?.propositions ?? [];
			const picked: Array<{ id: string; name: string; statement: string }> = [];
			for (const id of ids) {
				const node = propositionsList.find((candidate) => candidate.id === id);
				if (node) picked.push({ id: node.id, name: node.name, statement: node.statement });
			}
			onPracticeSelectionChange?.(picked);
		}}
	/>
</div>
