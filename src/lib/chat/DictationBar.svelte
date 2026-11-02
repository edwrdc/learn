<script lang="ts">
	import { Loader2, Mic } from "@lucide/svelte";
	import { hint } from "$lib/hint";
	import { settingsDialog } from "$lib/state/dialogs.svelte";
	import { DEEPGRAM_KEY_ID, DICTATION_KEYLESS, METER_CELLS, METER_TICK_MS, rmsToMeter, type DictationController } from "./dictation.svelte";

	let { dictation }: { dictation: DictationController } = $props();

	let levels = $state<number[]>(new Array(METER_CELLS).fill(0));
	let cellCount = $state(METER_CELLS);
	let meter = $state<HTMLDivElement | null>(null);

	const recording = $derived(dictation.phase === "recording" || dictation.phase === "stopping");
	const keyless = $derived(dictation.error === DICTATION_KEYLESS);

	$effect(() => {
		if (!dictation.active) return;
		levels = new Array(METER_CELLS).fill(0);
		const id = setInterval(() => {
			const next = levels.slice(1);
			next.push(rmsToMeter(dictation.level));
			levels = next;
		}, METER_TICK_MS);
		return () => clearInterval(id);
	});

	$effect(() => {
		if (!dictation.active) return;
		const el = meter;
		if (!el) return;
		const fit = () => (cellCount = Math.max(8, Math.min(METER_CELLS, Math.floor(el.clientWidth / 4))));
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(el);
		return () => ro.disconnect();
	});
</script>

{#if !dictation.active}
	<button
		type="button"
		onclick={() => {
			if (keyless) {
				dictation.clearError();
				settingsDialog.open("keys", DEEPGRAM_KEY_ID);
			} else dictation.toggle();
		}}
		aria-label={dictation.error ? `Dictation failed: ${dictation.error}` : "Start dictation"}
		data-testid="dictation-toggle"
		{@attach hint(dictation.error ?? "Dictate", { action: dictation.error ? undefined : "toggle-dictation", side: "top" })}
		class="flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border/50 bg-card/50 text-xs text-muted-foreground/70 shadow-lg backdrop-blur transition-colors hover:border-border hover:text-muted-foreground"
	>
		<Mic class="size-3.5" />
		<span class="max-w-full truncate">{dictation.error ?? "Dictate"}</span>
	</button>
{:else}
	<div class="flex w-full min-w-0 items-center gap-2" data-testid="dictation-bar">
		<button
			type="button"
			onclick={() => dictation.toggle()}
			disabled={dictation.phase === "stopping"}
			aria-label="Stop dictation"
			data-testid="dictation-toggle"
			{@attach hint("Stop dictation (Esc)", { side: "top" })}
			class="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-destructive/10 px-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
		>
			{#if dictation.phase === "stopping"}
				<Loader2 class="size-3.5 animate-spin" />
			{:else}
				<Mic class="size-3.5" />
			{/if}
			Stop
		</button>
		<span class="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden="true"></span>
		<div bind:this={meter} class="flex h-4 min-w-0 flex-1 items-center gap-[2px]" data-testid="dictation-meter">
			{#each levels.slice(-cellCount) as value, i (i)}
				<span class="min-w-0 flex-1 rounded-full bg-foreground/40" style="height: {2 + Math.round(value * 14)}px"></span>
			{/each}
		</div>
	</div>
{/if}
