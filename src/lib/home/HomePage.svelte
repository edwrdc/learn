<script lang="ts">
	import { type GraphContextPick } from "@/src/session/model";
	import SetupCta from "$lib/settings/SetupCta.svelte";
	import { plural } from "$lib/format";
import { untrack } from "svelte";
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { startDraftSession } from "./new-session";
	import { strongKeyless } from "$lib/state/keys";
	import { modelCatalog } from "$lib/state/model-catalog.svelte";
	import { CornerDownLeft, Dumbbell } from "@lucide/svelte";
	import type { TurnUsage } from "@/src/session/model";
	import { afterDictation, DictationController, joinDictation } from "$lib/chat/dictation.svelte";
	import DictationBar from "$lib/chat/DictationBar.svelte";
	import StatsBar from "$lib/chat/StatsBar.svelte";
	import SetupDialog from "$lib/settings/SetupDialog.svelte";
	import GraphView from "./GraphView.svelte";
	import MinimalHome from "./MinimalHome.svelte";
	import SidebarToggle from "$lib/shell/SidebarToggle.svelte";
	import { noProviderKey } from "$lib/state/keys.svelte";
	import { hint } from "$lib/hint";
	import { focusOnMount } from "$lib/dom";

	let { initialConfigured, rendering = true }: { initialConfigured: boolean; rendering?: boolean } = $props();

	let topic = $state("");
	let topicMirror = "";
	let configured = $state(untrack(() => initialConfigured));
	let setupOpen = $state(false);
	let busy = $state(false);
	let mode = $state<"teach" | "practice">("teach");
	let practiceProps = $state<GraphContextPick[]>([]);
	let chainSelectOpen = $state(false);
	let applied = false;

	const dictation = new DictationController((value) => applyTopic(joinDictation(topicMirror, value)));

	function applyTopic(value: string) {
		topicMirror = value;
		topic = value;
	}

	async function begin() {
		const text = topicMirror.trim();
		if (!text || busy) return;
		if (!configured) {
			setupOpen = true;
			return;
		}
		if (noProviderKey.value || strongKeyless(modelCatalog.value)) {
			setupOpen = true;
			return;
		}
		busy = true;
		try {
			const target = await startDraftSession(text, mode, practiceProps);
			if (target) void goto(target);
			else busy = false;
		} catch (error) {
			console.error("[new session] create failed:", error);
			busy = false;
		}
	}

	function start() {
		afterDictation(() => void begin());
	}

	onMount(() => {
		const off = dictation.mount();
		return off;
	});
</script>

<div class="relative h-dvh">
	<div class="lh-drag absolute inset-x-0 top-0 h-13" aria-hidden="true"></div>

	<main class="absolute inset-0">
		{#if rendering}
			<GraphView
				{chainSelectOpen}
				practiceSelection={new Set(practiceProps.map((p) => p.id))}
				onPracticeSelectionChange={(nodes) => (practiceProps = nodes)}
				onChainSelectClose={() => (chainSelectOpen = false)}
			/>
		{:else}
			<MinimalHome
				{chainSelectOpen}
				practiceSelection={new Set(practiceProps.map((p) => p.id))}
				onPracticeSelectionChange={(nodes) => (practiceProps = nodes)}
				onChainSelectClose={() => (chainSelectOpen = false)}
			/>
		{/if}
	</main>

	<header class="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 px-3 py-2">
		<div class="pointer-events-auto"><SidebarToggle /></div>
	</header>

	<div class="pointer-events-none absolute inset-x-0 bottom-0 pb-5">
		<div class="pointer-events-auto mx-auto w-full max-w-[46rem] px-4">
			{#if practiceProps.length > 0 || mode === "practice" || noProviderKey.value || !configured}
				<div data-testid="composer-actions" class="pointer-events-auto mb-2 flex flex-wrap items-center gap-2 {practiceProps.length > 0 || mode === 'practice' ? 'justify-start' : 'justify-center'}">
					{#if practiceProps.length > 0 || mode === "practice"}
						<div class="flex items-center gap-1.5">
							<button type="button" data-testid="practice-props-chip" onclick={() => (chainSelectOpen = true)} class="flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-ui text-xs transition-colors {practiceProps.length > 0 ? 'border-border bg-card text-foreground hover:bg-accent' : 'border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground'}">
								<Dumbbell aria-hidden="true" class="size-3.5 text-muted-foreground" />
								{practiceProps.length > 0 ? `${plural(practiceProps.length, "node")} selected` : "Pick nodes"}
							</button>
							{#if practiceProps.length > 0}
								<button type="button" data-testid="practice-props-clear" onclick={() => (practiceProps = [])} class="cursor-pointer rounded-full px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">Clear</button>
							{/if}
						</div>
					{/if}
					<SetupCta {configured} onOpen={() => (setupOpen = true)} />
				</div>
			{/if}
			<form class="flex items-end gap-1.5 rounded-2xl border bg-card p-1.5 shadow-lg" onsubmit={(event) => { event.preventDefault(); start(); }}>
				<textarea
					value={topic}
					oninput={(event) => applyTopic((event.currentTarget as HTMLTextAreaElement).value)}
					onkeydown={(event) => {
						if (event.key === "Escape" && dictation.active) {
							event.preventDefault();
							event.stopPropagation();
							dictation.cancel();
							return;
						}
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							start();
						}
					}}
					placeholder={mode === "practice" ? "What do you want to practice?" : "What do you want to learn?"}
					{@attach focusOnMount()}
					rows={1}
					class="field-sizing-content lh-input max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
				></textarea>
				<button type="submit" aria-label="Start session" disabled={(!topic.trim() && !dictation.active) || busy} class="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-primary text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-40">
					<CornerDownLeft class="size-5" />
				</button>
			</form>
			<StatsBar turns={[] as TurnUsage[]} chatId={undefined}>
				{#snippet dictationSlot()}<DictationBar {dictation} />{/snippet}
				{#snippet leadingSlot()}
					<div class="flex items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5" data-testid="home-mode-switch">
						{#each [["teach", "Teach"], ["practice", "Practice"]] as [value, label] (value)}
							<button type="button" data-testid={`home-mode-${value}`} onclick={() => (mode = value as "teach" | "practice")} class="flex items-center gap-1 rounded-sm px-2 py-0.5 text-[11px] uppercase tracking-wider transition-colors {mode === value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}">
								{#if value === "practice"}<Dumbbell aria-hidden="true" class="size-3" />{/if}
								{label}
							</button>
						{/each}
					</div>
				{/snippet}
			</StatsBar>
		</div>
	</div>

	<SetupDialog open={setupOpen} onClose={() => (setupOpen = false)} onDone={() => { configured = true; setupOpen = false; }} />
</div>
