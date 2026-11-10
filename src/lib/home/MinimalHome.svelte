<script lang="ts">
	import { ListTree } from "@lucide/svelte";
	import type { ChatSummary } from "@/src/session/model";
	import { serverEvents } from "$lib/state/server-events";
	import { graphCosts, graphSnapshot } from "$lib/state/graph.svelte";
	import { listChats } from "$lib/api/chats";
	import { hint } from "$lib/hint";
	import NotesImport from "./NotesImport.svelte";
	import { knowledgeEmpty, knowledgeLines, type KnowledgeCounts } from "./minimal-home";

	let { onOpenChains }: { onOpenChains: () => void } = $props();

	const snapshot = $derived(graphSnapshot.value ?? null);
	const costs = $derived(graphCosts.value ?? null);
	let chats = $state<ChatSummary[]>([]);

	function readState() {
		void graphSnapshot.refresh();
		listChats()
			.then((value) => (chats = value))
			.catch((error: unknown) => console.error("[home] sessions load failed:", error));
	}

	$effect(() => {
		readState();
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
				<button type="button" onclick={onOpenChains} data-testid="open-chain-table" {@attach hint("Every reasoning chain", { side: "bottom" })} class="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"><ListTree class="size-3" />Chains</button>
			</div>
			<div class="shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
				<NotesImport onFinished={() => { readState(); void graphCosts.refresh(); }} />
			</div>
		</div>
		{#if costs && costs.runs.length > 0}
			<span class="rounded-lg px-2 py-1 text-xs tabular-nums text-muted-foreground">${(costs.stages.extraction.dollars + costs.stages.audit.dollars).toFixed(2)}</span>
		{/if}
	</div>
</div>
