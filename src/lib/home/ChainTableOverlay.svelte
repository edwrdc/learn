<script lang="ts">
	import { dismissLayer } from "$lib/ui/layer";
	import { plural } from "$lib/format";
	import { emitAppEvent } from "$lib/events";
	import { Dumbbell, ChevronDown, ChevronRight, ChevronUp, Folder, FolderOpen, Search, Trash2, X } from "@lucide/svelte";
	import { birthSessionOf, chainsForSelection, formatChainLine, type GraphNode, type GraphSnapshot, type ReasoningChain } from "@/src/graph/model";
	import { fuzzyScore } from "@/src/platform/model";
	import TopBar from "$lib/shell/TopBar.svelte";
	import DeleteNodeDialog from "./DeleteNodeDialog.svelte";

	type Col = "name" | "props" | "created";

	let {
		open,
		snapshot,
		onClose,
		selectMode = false,
		controlledSelection,
		onSelectionChange,
	}: {
		open: boolean;
		/** The graph the table reads (its stored propositions and chains). */
		snapshot: GraphSnapshot | null;
		onClose: () => void;
		selectMode?: boolean;
		controlledSelection?: ReadonlySet<string>;
		onSelectionChange?: (ids: string[]) => void;
	} = $props();

	let query = $state("");
	let sort = $state<{ col: Col; dir: 1 | -1 }>({ col: "name", dir: 1 });
	let internalSelection = $state<Set<string>>(new Set());
	let expandedClusters = $state<Set<string>>(new Set());
	let expandedChains = $state<Set<string>>(new Set());
	let deleting = $state<{ id: string; name: string }[] | null>(null);

	const nodes = $derived(snapshot?.propositions ?? []);
	const storedChains = $derived(snapshot?.chains ?? []);
	const sessions = $derived(snapshot?.sessions ?? {});
	const fileSources = $derived(snapshot?.fileSources ?? {});
	const selection = $derived(controlledSelection ?? internalSelection);
	const byId = $derived(new Map(nodes.map((node) => [node.id, node])));
	const chains = $derived(chainsForSelection(nodes, storedChains));
	const searching = $derived(query.trim() !== "");

	function setSelection(next: Set<string>) {
		internalSelection = next;
		onSelectionChange?.([...next]);
	}

	function toggleNodes(ids: string[], next: boolean) {
		const set = new Set(selection);
		for (const id of ids) {
			if (next) set.add(id);
			else set.delete(id);
		}
		setSelection(set);
	}

	const visibleChains = $derived.by(() => {
		if (!searching) return chains;
		const scored = chains
			.map((chain) => {
				let best: number | null = null;
				for (const id of [...chain.premises, chain.conclusion]) {
					const node = byId.get(id);
					if (!node) continue;
					const value = fuzzyScore(query, node.name, node.statement, ...node.aliases);
					if (value === null) continue;
					if (best === null || value > best) best = value;
				}
				return best === null ? null : { chain, best };
			})
			.filter((entry): entry is { chain: ReasoningChain; best: number } => entry !== null);
		return scored.sort((a, b) => b.best - a.best || (a.chain.id < b.chain.id ? -1 : 1)).map((entry) => entry.chain);
	});

	const groups = $derived.by(() => {
		const map = new Map<string, { key: string; birth: string | null; label: string | null; kind: "chat" | "notes" | null; chains: ReasoningChain[]; nodeIds: string[]; newest: string }>();
		for (const chain of visibleChains) {
			const conclusion = byId.get(chain.conclusion);
			const birth = conclusion ? birthSessionOf(conclusion) : null;
			const key = birth ?? "\0unlabeled";
			let group = map.get(key);
			if (!group) {
				const label = birth === null ? null : (sessions[birth] ?? fileSources[birth] ?? null);
				const kind = birth === null ? null : sessions[birth] !== undefined ? "chat" : fileSources[birth] !== undefined ? "notes" : null;
				group = { key, birth, label, kind, chains: [], nodeIds: [], newest: "" };
				map.set(key, group);
			}
			group.chains.push(chain);
			for (const id of [...chain.premises, chain.conclusion]) {
				if (!group.nodeIds.includes(id)) group.nodeIds.push(id);
				const createdAt = byId.get(id)?.createdAt ?? "";
				if (createdAt > group.newest) group.newest = createdAt;
			}
		}
		const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
		const list = [...map.values()];
		const nameKey = (group: { label: string | null }) => group.label ?? "\uffff";
		const cmpName = (a: typeof list[number], b: typeof list[number]) => collator.compare(nameKey(a), nameKey(b)) * (sort.col === "name" ? sort.dir : 1);
		list.sort((a, b) =>
			sort.col === "created"
				? (sort.dir === -1 ? b.newest.localeCompare(a.newest) : a.newest.localeCompare(b.newest)) || cmpName(a, b)
				: sort.col === "props"
					? (sort.dir === -1 ? b.nodeIds.length - a.nodeIds.length : a.nodeIds.length - b.nodeIds.length) || cmpName(a, b)
					: cmpName(a, b),
		);
		for (const group of list) {
			const chainName = (chain: ReasoningChain) => byId.get(chain.conclusion)?.name ?? chain.conclusion;
			const chainDate = (chain: ReasoningChain) => byId.get(chain.conclusion)?.createdAt ?? "";
			group.chains.sort((a, b) =>
				sort.col === "created"
					? (sort.dir === -1 ? chainDate(b).localeCompare(chainDate(a)) : chainDate(a).localeCompare(chainDate(b))) || collator.compare(chainName(a), chainName(b))
					: sort.col === "props"
						? (sort.dir === -1 ? (b.premises.length + 1) - (a.premises.length + 1) : (a.premises.length + 1) - (b.premises.length + 1)) || collator.compare(chainName(a), chainName(b))
						: collator.compare(chainName(a), chainName(b)) * sort.dir,
			);
		}
		return list;
	});

	const derivedChains = $derived(chainsForSelection([...selection].map((id) => byId.get(id)).filter((n): n is GraphNode => n !== undefined), storedChains));

	function toggleSort(col: Col) {
		sort = sort.col === col ? { col, dir: sort.dir === 1 ? -1 : 1 } : { col, dir: col === "created" || col === "props" ? -1 : 1 };
	}

	function toggleSet(set: Set<string>, key: string): Set<string> {
		const next = new Set(set);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		return next;
	}

	function dirIcon(col: Col) {
		if (sort.col !== col) return null;
		return sort.dir === 1 ? "asc" : "desc";
	}

	function onDeleted(ids: string[], revision: number) {
		const remaining = deleting?.filter((node) => !ids.includes(node.id)) ?? [];
		deleting = remaining.length > 0 ? remaining : null;
		setSelection(new Set([...selection].filter((id) => !ids.includes(id))));
		emitAppEvent("graph-revision", { graphRevision: revision });
	}

	$effect(() => {
		if (!open) return;
		return dismissLayer(onClose, { clickOutside: false });
	});
</script>

{#if open}
	<div data-testid="chain-table" class="chain-table-overlay absolute inset-0 z-40 flex h-full min-h-0 flex-col bg-background/85 backdrop-blur-sm">
		<TopBar>
			<span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{plural(chains.length, "chain")} · {plural(nodes.length, "node")}</span>
			<div class="relative shrink-0">
				<Search class="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
				<input value={query} data-testid="chain-table-search" oninput={(event) => (query = (event.currentTarget as HTMLInputElement).value)} placeholder="Search nodes…" aria-label="Search nodes" spellcheck={false} class="lh-no-drag h-8 w-56 rounded-lg border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground focus:border-ring" />
			</div>
			<button type="button" data-testid="chain-table-close" onclick={onClose} aria-label="Close chains" class="lh-no-drag flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-card/80 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"><X class="size-4" /></button>
		</TopBar>

		<div class="min-h-0 flex-1 overflow-y-auto">
			<div class="sticky top-0 z-10 flex items-center gap-1 border-b border-border/60 bg-background/80 px-3 py-1.5 text-[11px] uppercase tracking-widest text-muted-foreground/70 backdrop-blur">
				<button type="button" data-testid="sort-name" role="columnheader" onclick={() => toggleSort("name")} aria-sort={sort.col === "name" ? (sort.dir === 1 ? "ascending" : "descending") : "none"} class="flex flex-1 items-center gap-1 text-left transition-colors hover:text-foreground">Name {#if dirIcon("name") === "asc"}<ChevronUp class="size-3" />{:else if dirIcon("name") === "desc"}<ChevronDown class="size-3" />{/if}</button>
				<button type="button" data-testid="sort-props" role="columnheader" onclick={() => toggleSort("props")} aria-sort={sort.col === "props" ? (sort.dir === 1 ? "ascending" : "descending") : "none"} class="flex w-14 shrink-0 items-center justify-end gap-1 text-right transition-colors hover:text-foreground">Props {#if dirIcon("props") === "asc"}<ChevronUp class="size-3" />{:else if dirIcon("props") === "desc"}<ChevronDown class="size-3" />{/if}</button>
				<button type="button" data-testid="sort-created" role="columnheader" onclick={() => toggleSort("created")} aria-sort={sort.col === "created" ? (sort.dir === 1 ? "ascending" : "descending") : "none"} class="flex w-20 shrink-0 items-center justify-end gap-1 text-right transition-colors hover:text-foreground">Created {#if dirIcon("created") === "asc"}<ChevronUp class="size-3" />{:else if dirIcon("created") === "desc"}<ChevronDown class="size-3" />{/if}</button>
			</div>

			{#if groups.length === 0}
				<div data-testid="chain-table-nomatch" class="px-4 pt-3 text-xs text-muted-foreground">No matching chains.</div>
			{/if}

			{#each groups as group (group.key)}
				{@const openGroup = searching || expandedClusters.has(group.key)}
				{@const selectedCount = group.nodeIds.filter((id) => selection.has(id)).length}
				<div data-testid={`cluster-group-${group.key}`} class="relative border-b border-border/60">
					{#if openGroup && group.chains.length > 0}
						<div data-testid={`cluster-thread-${group.key}`} aria-hidden="true" class="pointer-events-none absolute bottom-[8px] left-[37px] top-[23px] w-px bg-border/50"></div>
					{/if}
					<div class="flex items-center gap-1 px-3 py-1.5">
						<input
							type="checkbox"
							checked={selectedCount === group.nodeIds.length && group.nodeIds.length > 0}
							onchange={(event) => toggleNodes(group.nodeIds, (event.currentTarget as HTMLInputElement).checked)}
							data-testid={`cluster-checkbox-${group.key}`}
							aria-label={`Select everything born in ${group.label ?? "unlabeled"}`}
							class="size-3.5 shrink-0 accent-primary"
						/>
						<button type="button" data-testid={`cluster-toggle-${group.key}`} onclick={() => (expandedClusters = toggleSet(expandedClusters, group.key))} aria-label={`Expand cluster ${group.label ?? "unlabeled"}`} aria-expanded={openGroup} class="flex h-5 w-3.5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"><ChevronRight class="size-3.5 transition-transform {openGroup ? 'rotate-90' : ''}" /></button>
						<span class="flex shrink-0 items-center justify-center text-muted-foreground">{#if openGroup}<FolderOpen class="size-3.5" />{:else}<Folder class="size-3.5" />{/if}</span>
						<span class="min-w-0 flex-1 truncate text-sm font-medium">{group.label ?? "unlabeled"}{#if group.kind === "notes"}<span class="ml-2 text-[11px] uppercase tracking-widest text-muted-foreground/60">notes</span>{/if}</span>
						<span class="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{group.nodeIds.length}</span>
						<span class="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{group.newest.slice(0, 10)}</span>
					</div>

					{#if openGroup}
						{#each group.chains as chain (chain.id)}
							{@const memberIds = [...chain.premises, chain.conclusion]}
							{@const chainOpen = expandedChains.has(chain.id)}
							{@const selectedInChain = memberIds.filter((id) => selection.has(id)).length}
							<div data-testid={`chain-block-${chain.id}`} class="relative">
								{#if chainOpen && memberIds.length > 0}
									<div data-testid={`chain-thread-${chain.id}`} aria-hidden="true" class="pointer-events-none absolute bottom-[8px] left-[73px] top-[22px] w-px bg-border/50"></div>
								{/if}
								<div data-testid={`chain-row-${chain.id}`} aria-label={formatChainLine(chain, Object.fromEntries([...byId.entries()].map(([id, node]) => [id, { name: node.name }])))} class="flex items-center gap-1 py-1 pl-12 pr-3">
									<input type="checkbox" checked={selectedInChain === memberIds.length && memberIds.length > 0} onchange={(event) => toggleNodes(memberIds, (event.currentTarget as HTMLInputElement).checked)} data-testid={`chain-checkbox-${chain.id}`} aria-label={`Select chain ${byId.get(chain.conclusion)?.name ?? chain.conclusion}`} class="size-3.5 shrink-0 accent-primary" />
									<button type="button" data-testid={`chain-toggle-${chain.id}`} onclick={() => (expandedChains = toggleSet(expandedChains, chain.id))} aria-label={`Expand chain ${byId.get(chain.conclusion)?.name ?? chain.conclusion}`} aria-expanded={chainOpen} class="flex h-5 w-3.5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"><ChevronRight class="size-3.5 transition-transform {chainOpen ? 'rotate-90' : ''}" /></button>
									<span class="flex min-w-0 flex-1 flex-wrap items-center gap-x-0.5 gap-y-1 text-[13px] leading-tight">
										{#each memberIds as id, i (id)}
											{@const isConclusion = i === memberIds.length - 1}
											<span class="flex items-center">
												{#if i > 0}
													<span class="px-1.5 text-foreground" data-testid={isConclusion ? `chain-implies-${chain.id}` : `chain-and-${chain.id}-${i}`}>{isConclusion ? "⟹" : "∧"}</span>
												{/if}
												<span data-testid={`prop-chip-${id}`} class="rounded border border-border/70 bg-muted/30 px-1.5 py-0.5">{byId.get(id)?.name ?? id}</span>
											</span>
										{/each}
									</span>
									<span class="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{memberIds.length}</span>
									<span class="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{byId.get(chain.conclusion)?.createdAt.slice(0, 10) ?? ""}</span>
								</div>
								{#if chainOpen}
									{#each memberIds as id (id)}
										{@const node = byId.get(id)}
										{#if node}
											<div data-testid={`prop-row-${id}`} class="flex items-start gap-2 py-1 pl-21 pr-3">
												<input type="checkbox" checked={selection.has(id)} onchange={(event) => toggleNodes([id], (event.currentTarget as HTMLInputElement).checked)} data-testid={`prop-checkbox-${id}`} aria-label={`Select node ${node.name}`} class="mt-0.5 size-3.5 shrink-0 accent-primary" />
												<span class="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">{node.statement}</span>
												<span class="w-14 shrink-0"></span>
												<span class="w-20 shrink-0"></span>
											</div>
										{/if}
									{/each}
								{/if}
							</div>
						{/each}
					{/if}
				</div>
			{/each}
		</div>

		{#if selection.size > 0}
			<div class="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center pb-4">
				<div data-testid="chain-selection-bar" class="pointer-events-auto flex items-center gap-3 rounded-full border bg-card px-4 py-2 shadow-lg">
					<span data-testid="chain-selected-summary" class="text-xs font-medium">{plural(selection.size, "node")} → {plural(derivedChains.length, "chain")}</span>
					<button type="button" data-testid="chain-clear" onclick={() => setSelection(new Set())} class="rounded-full px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">Clear</button>
					{#if selectMode}
						<button type="button" data-testid="chain-practice-done" onclick={() => { onClose(); }} aria-label={`Done picking — ${selection.size} ${selection.size === 1 ? "proposition" : "propositions"} selected`} class="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80"><Dumbbell aria-hidden="true" class="size-3.5" />Done</button>
					{:else}
						<span data-testid="chain-danger-divider" aria-hidden="true" class="h-4 w-px bg-border/70"></span>
						<button type="button" data-testid="chain-delete" onclick={() => (deleting = [...selection].map((id) => ({ id, name: byId.get(id)?.name ?? id })))} aria-label={`Delete ${selection.size} selected ${selection.size === 1 ? "node" : "nodes"}`} class="flex items-center gap-1.5 rounded-full border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"><Trash2 aria-hidden="true" class="size-3.5" />Delete</button>
					{/if}
				</div>
			</div>
		{/if}
	</div>
	<DeleteNodeDialog nodes={deleting} onClose={() => (deleting = null)} onDeleted={onDeleted} />
{/if}
