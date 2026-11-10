<script lang="ts">
	import { picksFor, type GraphContextPick } from "@/src/session/model";
	import SetupCta from "$lib/settings/SetupCta.svelte";
	import { plural } from "$lib/format";
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { startDraftSession } from "./new-session";
	import type { TurnUsage } from "@/src/session/model";
	import Composer from "$lib/chat/Composer.svelte";
	import { withCode } from "$lib/chat/code-input";
	import DictationBar from "$lib/chat/DictationBar.svelte";
	import StatsBar from "$lib/chat/StatsBar.svelte";
	import SidebarToggle from "$lib/shell/SidebarToggle.svelte";
	import ChainTableOverlay from "./ChainTableOverlay.svelte";
	import SetupDialog from "$lib/settings/SetupDialog.svelte";
	import { afterDictation, DictationController, joinDictation } from "$lib/chat/dictation.svelte";
	import { needsSetup, noProviderKey } from "$lib/state/keys.svelte";
	import { settings } from "$lib/state/settings.svelte";
	import { graphSnapshot } from "$lib/state/graph.svelte";

	let { initialConfigured, mode = "teach" }: { initialConfigured: boolean; mode?: "teach" | "practice" } = $props();

	let text = $state("");
	let code = $state("");
	let textMirror = "";
	let busy = $state(false);
	const configured = $derived(settings.configured ?? initialConfigured);
	let setupOpen = $state(false);
	let picks = $state<GraphContextPick[]>([]);
	let pickerOpen = $state(false);
	const snapshot = $derived(graphSnapshot.value ?? null);

	const dictation = new DictationController((value) => applyText(joinDictation(textMirror, value)));

	function applyText(value: string) {
		textMirror = value;
		text = value;
	}

	function openPicker() {
		if (snapshot) {
			pickerOpen = true;
			return;
		}
		void graphSnapshot.refresh().then(() => {
			if (graphSnapshot.value) pickerOpen = true;
		});
	}


	function send() {
		const draft = withCode(textMirror, code).trim();
		if (!draft || busy) return;
		if (needsSetup(configured)) {
			setupOpen = true;
			return;
		}
		busy = true;
		const title = textMirror.trim() || "Code";
		void startDraftSession(draft, mode, picks, title)
			.then((target) => {
				if (target) void goto(target);
				else busy = false;
			})
			.catch((error) => {
				console.error("[new session] create failed:", error);
				busy = false;
			});
	}

	function handleSend() {
		afterDictation(send);
	}

	onMount(() => {
		return dictation.mount();
	});

	const canSend = $derived(text.trim().length > 0 || code.trim().length > 0 || dictation.active);
</script>

<div class="relative flex h-dvh">
	<div class="lh-drag absolute inset-x-0 top-0 h-13" aria-hidden="true"></div>
	<div class="flex min-w-0 flex-1 flex-col">
		<div class="relative flex min-h-0 flex-1">
			<div class="pointer-events-none sticky bottom-0 mt-auto w-full">
				<div class="relative flex-1 overflow-y-hidden" role="log">
					<div class="flex min-h-full flex-col gap-0 p-0">
						<div class="flex size-full flex-col items-center justify-center gap-3 p-8 text-center">
							<div class="space-y-1">
								<h3 class="font-medium text-sm">{mode === "practice" ? "New practice session" : "New session"}</h3>
								<p class="text-muted-foreground text-sm">
									{mode === "practice"
										? "Pick nodes from your knowledge graph, describe what you want to practice, or bring your own problem."
										: "The teacher will open by probing what you already know."}
								</p>
							</div>
						</div>
					</div>
				</div>
				<div class="h-24 bg-gradient-to-t from-background via-background/85 to-transparent"></div>
				<div class="bg-background pb-4">
					<div class="mx-auto w-full max-w-[46rem] px-4">
						{#if picks.length > 0 || mode === "practice" || noProviderKey.value || !configured}
							<div data-testid="composer-actions" class="pointer-events-auto mb-2 flex flex-wrap items-center gap-2 {picks.length > 0 || mode === 'practice' ? 'justify-start' : 'justify-center'}">
								{#if picks.length > 0 || mode === "practice"}
									<div class="flex items-center gap-1.5">
										<button type="button" data-testid="practice-props-chip" onclick={openPicker} class="flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-ui text-xs transition-colors {picks.length > 0 ? 'border-border bg-card text-foreground hover:bg-accent' : 'border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground'}">
											<span aria-hidden="true" class="text-muted-foreground">◎</span>
											{picks.length > 0 ? `${plural(picks.length, "node")} selected` : "Pick nodes"}
										</button>
										{#if picks.length > 0}
											<button type="button" data-testid="practice-props-clear" onclick={() => (picks = [])} class="cursor-pointer rounded-full px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">Clear</button>
										{/if}
									</div>
								{/if}
								<SetupCta {configured} onOpen={() => (setupOpen = true)} />
							</div>
						{/if}
						<div class="pointer-events-auto overflow-hidden rounded-2xl border bg-card shadow-lg">
							<Composer
								busy={busy}
								value={text}
								{code}
								onCodeChange={(value) => (code = value)}
								onChange={applyText}
								onSend={handleSend}
								onStop={() => {}}
								{canSend}
								autoFocus
								placeholder={mode === "practice" ? "What do you want to practice?" : "What do you want to learn?"}
							/>
						</div>
						<StatsBar turns={[] as TurnUsage[]}>
							{#snippet dictationSlot()}<DictationBar {dictation} />{/snippet}
						</StatsBar>
					</div>
				</div>
			</div>
			<ChainTableOverlay
				open={pickerOpen}
				{snapshot}
				onClose={() => (pickerOpen = false)}
				selectMode
				controlledSelection={new Set(picks.map((pick) => pick.id))}
				onSelectionChange={(ids) => {
					picks = picksFor(ids, snapshot?.propositions ?? []);
				}}
			/>
		</div>
	</div>
	<header class="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 px-3 py-2">
		<div class="pointer-events-auto"><SidebarToggle /></div>
	</header>
</div>

<SetupDialog open={setupOpen} onClose={() => (setupOpen = false)} onDone={() => (setupOpen = false)} />
