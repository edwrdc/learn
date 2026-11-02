<script lang="ts">
	import { COMPACTION_THRESHOLD_FLOOR, MODEL_SLOTS, resolveSettings, type AgentSettings, type CompactionSettings, type GraphSettings, type ModelCatalogEntry, type ModelsSettings, type ModelSlotName } from "@/src/core";
	import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
	import { prettyModel } from "$lib/format";
	import { watchSettings } from "$lib/state/settings-signal";
	import { composePromptSwitch, composeQuizMechanics, composeSearchEngine, composeSlotModel, composeTool, defaultOrderLevel, populateLevel, PROMPT_IN_USE_HINT, sectionedSegments, THINKING_LABEL, type SegmentInfo } from "./compose";
	import MenuShell from "$lib/ui/MenuShell.svelte";
	import Toggle from "$lib/ui/Toggle.svelte";
	import Controls from "./Controls.svelte";
	import CommitInput from "./CommitInput.svelte";
	import ModelMenuList from "./ModelMenuList.svelte";
	import ThinkingMenuList from "./ThinkingMenuList.svelte";

	interface ModelsBody { models: ModelCatalogEntry[]; slots: Record<ModelSlotName, { model: { provider: string; id: string }; thinkingLevel?: string } | null> }

	const SLOT_META: Record<ModelSlotName, { label: string; roster: string }> = {
		strong: { label: "Strong", roster: "The main model for your sessions" },
		cheap: { label: "Cheap", roster: "The assistants that research, build demos, and grade your work" },
		vision: { label: "Vision", roster: "The assistants that draw and read PDFs" },
	};
	const SEARCH_ENGINES = ["tavily", "brave"] as const;
	const TOGGLE_TOOLS = ["research", "demo", "visual", "pdf"] as const;
	const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

	let {
		agent,
		models,
		graph,
		compaction,
		onSectionChange,
		onModelsChange,
		onCompactionChange,
	}: {
		agent: AgentSettings | undefined;
		models: ModelsSettings | undefined;
		graph: GraphSettings | undefined;
		compaction: CompactionSettings | undefined;
		onSectionChange: (next: AgentSettings) => void;
		onModelsChange: (next: ModelsSettings) => void;
		onCompactionChange: (next: CompactionSettings) => void;
	} = $props();

	let catalog = $state<ModelCatalogEntry[] | null>(null);
	let slots = $state<ModelsBody["slots"] | null>(null);
	let search = $state<{ available: boolean; engine: string | null; reason: string } | null>(null);
	let engineKeys = $state<Partial<Record<(typeof SEARCH_ENGINES)[number], boolean>>>({});
	let prompts = $state<{ prober: SegmentInfo[]; teacher: SegmentInfo[] } | null>(null);
	let openSegment = $state<string | null>(null);
	let segmentDraft = $state<Record<string, string>>({});
	let segmentStatus = $state<string | null>(null);
	let openMenu = $state<{ target: ModelSlotName | "search"; kind: "model" | "thinking" | "engine" } | null>(null);
	let addAnchor = $state<HTMLElement | null>(null);

	function readModels() {
		fetch("/api/models")
			.then((r) => r.json() as Promise<ModelsBody>)
			.then((body) => {
				catalog = body.models;
				slots = body.slots;
			})
			.catch(() => (catalog = null));
	}
	function readPrompts() {
		fetch("/api/settings/prompts")
			.then((r) => r.json() as Promise<{ prober: SegmentInfo[]; teacher: SegmentInfo[] }>)
			.then((body) => (prompts = body))
			.catch(() => {});
	}
	function refreshSearch() {
		fetch("/api/search")
			.then((r) => r.json())
			.then((body: { available: boolean; engine: string | null; reason: string }) => (search = body))
			.catch(() => (search = null));
	}

	$effect(() => {
		readModels();
		readPrompts();
		fetch("/api/keys")
			.then((r) => r.json())
			.then((body: { keys: Array<{ id: string; present: boolean }> }) => {
				const present: Partial<Record<(typeof SEARCH_ENGINES)[number], boolean>> = {};
				for (const id of SEARCH_ENGINES) {
					const envVar = id === "tavily" ? "TAVILY_API_KEY" : "BRAVE_API_KEY";
					present[id] = body.keys.some((k) => k.id === envVar && k.present);
				}
				engineKeys = present;
			})
			.catch(() => {});
	});

	$effect(() => {
		void agent?.search?.engine;
		refreshSearch();
	});

	$effect(() => watchSettings((section) => {
		if (section === "models") readModels();
		if (section === "agent") readPrompts();
	}));

	$effect(() => {
		if (openMenu === null || typeof document === "undefined") return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (target instanceof Element && target.closest('[data-testid^="slot-"], [data-testid="search-engine-trigger"]')) return;
			if (target instanceof Element && target.closest('[role="dialog"]')) openMenu = null;
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			openMenu = null;
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	});


	function composeGraphTools(on: boolean): AgentSettings {
		return { ...agent, graphTools: { enabled: on } };
	}

	async function saveSegment(path: string, text: string) {
		segmentStatus = null;
		const res = await fetch(`/api/settings/prompts/${path}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text }),
		});
		if (!res.ok) {
			segmentStatus = `Save failed: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status}`;
			return;
		}
		readPrompts();
		segmentStatus = "Saved";
		if (agent?.prompts?.[path] !== true) onSectionChange(composePromptSwitch(agent, path, true));
	}
	async function deleteSegment(path: string) {
		segmentStatus = null;
		const res = await fetch(`/api/settings/prompts/${path}`, { method: "DELETE" });
		if (!res.ok) {
			segmentStatus = `Delete failed: ${res.status}`;
			return;
		}
		if (agent?.prompts?.[path] === true) onSectionChange(composePromptSwitch(agent, path, false));
		readPrompts();
		segmentStatus = "Deleted";
	}

	const resolvedCompaction = $derived(resolveSettings(compaction === undefined ? null : { version: 1, compaction }).compaction);
</script>

<Controls kind="group" label="Models" testid="group-models">
	{#each MODEL_SLOTS as slot (slot)}
		{@const override = models?.[slot]}
		{@const modelId = override?.model?.id ?? ""}
		{@const provider = override?.model?.provider ?? ""}
		{@const thinking = override?.thinkingLevel ?? ""}
		{@const pin = slots?.[slot]}
		{@const coord = override?.model ?? pin?.model}
		{@const chosen = coord ? catalog?.find((model) => model.id === coord.id && model.provider === coord.provider) : undefined}
		{@const levels = chosen ? chosen.supportedLevels : THINKING_LEVELS}
		{@const thisMenu = openMenu?.target === slot ? openMenu.kind : null}
		{@const slotCatalog = slot === "vision" ? catalog?.filter((model) => model.input.includes("image")) : catalog}
		<Controls kind="row" label={SLOT_META[slot].label} hint={SLOT_META[slot].roster} testid={`slot-row-${slot}`}>
			<span class="relative flex items-center gap-2">
				<button type="button" aria-label={`${SLOT_META[slot].label} model`} aria-expanded={thisMenu === "model"} data-testid={`slot-model-${slot}`} onclick={() => (openMenu = thisMenu === "model" ? null : { target: slot, kind: "model" })} class="flex h-7 min-w-20 items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50">
					<span class="min-w-0 flex-1 truncate">{modelId ? prettyModel(modelId) : "—"}</span>
					<span aria-hidden="true" class="text-muted-foreground">▾</span>
				</button>
				<span>
					<button type="button" aria-label={`${SLOT_META[slot].label} thinking`} aria-expanded={thisMenu === "thinking"} data-testid={`slot-thinking-${slot}`} onclick={() => (openMenu = thisMenu === "thinking" ? null : { target: slot, kind: "thinking" })} class="flex h-7 w-20 items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50">
						<span class="min-w-0 flex-1 truncate">{thinking || (chosen ? THINKING_LABEL[defaultOrderLevel(levels)] ?? defaultOrderLevel(levels) : "") || "—"}</span>
						<span aria-hidden="true" class="text-muted-foreground">▾</span>
					</button>
				</span>
				{#if thisMenu === "model"}
					<MenuShell anchorTestid={`slot-model-${slot}`} testid={`slot-model-menu-${slot}`} preferredSide="down" menuClass="flex w-[22rem] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl">
						<ModelMenuList
							models={slotCatalog ?? undefined}
							effectiveId={modelId}
							effectiveProvider={provider}
							onPick={(entry) => {
								const next = populateLevel(thinking || undefined, entry.supportedLevels);
								onModelsChange(composeSlotModel(models, slot, entry.provider, entry.id, next));
								openMenu = null;
							}}
							footer={catalog && catalog.length === 0 ? "No models — add a provider key in Keys" : "Runs every agent of this tier"}
						/>
					</MenuShell>
				{/if}
				{#if thisMenu === "thinking"}
					<MenuShell anchorTestid={`slot-thinking-${slot}`} testid={`slot-thinking-menu-${slot}`} preferredSide="down" menuClass="flex w-44 flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl">
						<ThinkingMenuList
							levels={levels.map(String)}
							effectiveLevel={thinking || (chosen ? defaultOrderLevel(levels) : undefined)}
							onPick={(level) => {
								onModelsChange(composeSlotModel(models, slot, provider, modelId, level));
								openMenu = null;
							}}
						/>
					</MenuShell>
				{/if}
			</span>
		</Controls>
	{/each}
</Controls>

<Controls kind="group" label="Tools" testid="group-tools">
	{@const graphOn = graph?.enabled ?? true}
	<Controls kind="row" label="Graph tools" hint={graphOn ? "Lets the tutor consult your knowledge map between sessions" : "Graph is disabled"} testid="graph-tools-row" dimmed={!graphOn}>
		<Toggle checked={agent?.graphTools?.enabled ?? true} disabled={!graphOn} label="graph tools" onChange={(on) => onSectionChange(composeGraphTools(on))} />
	</Controls>
	{@const free = agent?.tools?.explain === true}
	<Controls kind="row" label="Quizzing" hint="How both tutors check your understanding" testid="quiz-mechanics-row">
		<div role="radiogroup" aria-label="Quizzing mechanics" class="flex rounded-lg border border-border/60 bg-muted/30 p-0.5">
			{#each [["choice", "Multiple choice"], ["free", "Free recall"]] as [mechanic, label] (mechanic)}
				{@const active = mechanic === "free" ? free : !free}
				<button type="button" role="radio" aria-checked={active} data-testid={`quiz-mechanics-${mechanic}`} onclick={() => onSectionChange(composeQuizMechanics(agent, mechanic as "choice" | "free"))} class="h-8 rounded-md px-3 text-sm font-medium transition-colors {active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}">{label}</button>
			{/each}
		</div>
	</Controls>
	{#each TOGGLE_TOOLS as id (id)}
		<Controls kind="row" label={`Tool · ${id}`} testid={`tool-row-${id}`}>
			<Toggle checked={agent?.tools?.[id] ?? true} label={`tool ${id}`} onChange={(on) => onSectionChange(composeTool(agent, id, on))} />
		</Controls>
	{/each}
	{@const engine = agent?.search?.engine ?? null}
	{@const anyKey = engineKeys.tavily === true || engineKeys.brave === true}
	{@const searchOpen = openMenu?.target === "search"}
	<Controls kind="row" label="Search engine" hint={search?.reason ?? undefined} testid="search-engine-row" dimmed={!anyKey}>
		<span class="relative flex items-center gap-2">
			<button type="button" aria-label="Search engine" aria-expanded={searchOpen} data-testid="search-engine-trigger" onclick={() => { if (anyKey) openMenu = searchOpen ? null : { target: "search", kind: "engine" }; }} class="flex h-7 min-w-20 items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors {anyKey ? 'hover:border-muted-foreground/50' : 'cursor-not-allowed'}">
				<span class="min-w-0 flex-1 truncate">{engine === "tavily" ? "Tavily" : engine === "brave" ? "Brave" : "Automatic"}</span>
				<span aria-hidden="true" class="text-muted-foreground">▾</span>
			</button>
			{#if searchOpen}
				<MenuShell anchorTestid="search-engine-trigger" testid="search-engine-menu" preferredSide="down" menuClass="flex w-44 flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl">
					<button type="button" data-testid="engine-option-auto" onclick={() => { onSectionChange(composeSearchEngine(agent, null)); openMenu = null; }} class="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted {engine === null ? 'bg-muted/60 text-card-foreground' : 'text-card-foreground'}">
						<span>Automatic</span><span class="text-muted-foreground">{engine === null ? "✓" : ""}</span>
					</button>
					{#each SEARCH_ENGINES as id (id)}
						<button type="button" data-testid={`engine-option-${id}`} onclick={() => { onSectionChange(composeSearchEngine(agent, id)); openMenu = null; }} class="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted {engine === id ? 'bg-muted/60 text-card-foreground' : 'text-card-foreground'}">
							<span>{id === "tavily" ? "Tavily" : "Brave"}</span>
							<span class="text-muted-foreground">{engineKeys[id] ? "✓ key" : "· no key"}</span>
						</button>
					{/each}
				</MenuShell>
			{/if}
		</span>
	</Controls>
</Controls>

<Controls kind="group" label="Context" testid="group-context">
	<Controls kind="row" label="Compaction threshold" hint={`${resolvedCompaction.thresholdTokens} tok`} testid="compaction-row-threshold">
		<CommitInput
			type="number"
			value={String(compaction?.thresholdTokens ?? "")}
			placeholder={String(resolvedCompaction.thresholdTokens)}
			ariaLabel="compaction threshold"
			testid="input-compaction-threshold"
			onCommit={(value) => {
				if (value === "") return onCompactionChange({ ...compaction, thresholdTokens: undefined });
				const n = Number(value);
				if (Number.isFinite(n) && n > 0) onCompactionChange({ ...compaction, thresholdTokens: Math.max(COMPACTION_THRESHOLD_FLOOR, Math.round(n)) });
			}}
		/>
	</Controls>
</Controls>

<Controls kind="group" label="System prompts" testid="group-prompts">
	{#if prompts === null}
		<p class="text-xs text-muted-foreground/70">Loading prompt segments…</p>
	{:else}
		<div class="flex flex-col gap-4">
			{#each sectionedSegments(prompts) as section (section.id)}
				<div data-testid={`prompt-section-${section.id}`}>
					<p class="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">{section.label}</p>
					{#if section.hint}<p class="mb-1 text-xs text-muted-foreground/60">{section.hint}</p>{/if}
					<div class="flex flex-col gap-2">
						{#each section.segments as info (info.path)}
							{@const fileExists = info.overrideText !== null}
							{@const isOpen = openSegment === info.path}
							{@const draftValue = segmentDraft[info.path] ?? info.overrideText ?? ""}
							{@const dirty = draftValue !== (info.overrideText ?? "")}
							<div data-testid={`prompt-segment-${info.path}`}>
								<Controls kind="row" label={info.path} hint={info.enabled ? PROMPT_IN_USE_HINT : undefined} testid={`prompt-row-${info.path}`}>
									<span class={fileExists ? undefined : "opacity-40"}>
										<Toggle checked={info.enabled} disabled={!fileExists} label={`prompt ${info.path}`} onChange={(on) => onSectionChange(composePromptSwitch(agent, info.path, on))} />
									</span>
								</Controls>
								<button type="button" onclick={() => { openSegment = isOpen ? null : info.path; segmentStatus = null; }} class="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline">{isOpen ? "Hide text" : "Show text"}</button>
								{#if isOpen}
									<div class="mt-1 flex flex-col gap-2">
										<div>
											<p class="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">Source</p>
											<textarea readonly value={info.sourceText} aria-label="The original instructions" class="h-24 w-full resize-y rounded-sm border border-border bg-muted p-2 font-ui text-xs text-muted-foreground"></textarea>
										</div>
										<div>
											<p class="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">Override</p>
											<textarea value={draftValue} oninput={(event) => (segmentDraft = { ...segmentDraft, [info.path]: (event.currentTarget as HTMLTextAreaElement).value })} aria-label="Your version of the instructions" placeholder="Add your own instructions…" class="h-24 w-full resize-y rounded-sm border border-border bg-background p-2 font-ui text-xs text-foreground outline-none"></textarea>
										</div>
										<div class="flex items-center gap-3">
											<button type="button" disabled={!dirty} onclick={() => void saveSegment(info.path, segmentDraft[info.path] ?? "")} class={dirty ? "text-xs text-foreground underline-offset-2 hover:underline" : "cursor-not-allowed text-xs text-muted-foreground/40 underline-offset-2"}>Save</button>
											{#if fileExists}
												<button type="button" onclick={() => void deleteSegment(info.path)} class="text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline">Delete</button>
											{/if}
											{#if segmentStatus}<p class="text-xs text-muted-foreground/70" data-testid="segment-status">{segmentStatus}</p>{/if}
										</div>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</Controls>
