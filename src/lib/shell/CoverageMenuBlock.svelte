<script lang="ts">
	import { formatTokens, plural } from "$lib/format";
	import { extractChat } from "$lib/api/graph";
	import { ApiError } from "$lib/api/http";
	import { chatCoverage } from "$lib/state/coverage.svelte";


	let { chatId }: { chatId: string } = $props();
	const store = $derived(chatCoverage(chatId));
	const coverage = $derived(store.value);
	/** Requested here and not yet seen running: the button stays busy until the
	 *  run shows up (or the uncovered count moves). */
	let extracting = $state(false);
	let requestedAt: number | null = null;

	$effect(() => {
		extracting = false;
		requestedAt = null;
		void store.refresh();
	});

	$effect(() => {
		if (!extracting || !coverage) return;
		if (coverage.running || (requestedAt !== null && coverage.uncoveredTokens !== requestedAt)) extracting = false;
	});

	async function extract() {
		extracting = true;
		requestedAt = coverage?.uncoveredTokens ?? null;
		try {
			await extractChat(chatId);
		} catch (error) {
			if (!(error instanceof ApiError && error.status === 409)) {
				console.error(`[coverage ${chatId}] extraction request failed:`, error);
				extracting = false;
			}
		}
		void store.refresh();
	}

	const busy = $derived(coverage?.running === true || extracting);
	const complete = $derived(coverage !== null && coverage.uncoveredTokens === 0 && coverage.uncoveredCount === 0);
</script>

{#if coverage}
	<div data-testid="ctx-coverage" class="flex flex-col gap-1 px-2.5 pt-1 pb-2">
		{#if busy}
			<span class="flex items-center gap-1.5 text-muted-foreground" data-testid="ctx-coverage-running">
				<span class="size-1.5 animate-pulse rounded-full bg-foreground/70" aria-hidden="true"></span>
				extracting…
			</span>
		{:else if complete}
			<span class="text-muted-foreground">fully extracted</span>
		{:else}
			<span class="flex flex-col">
				<span class="tabular-nums text-foreground">{formatTokens(coverage.uncoveredTokens)} tok uncovered</span>
				<span class="tabular-nums text-muted-foreground">{plural(coverage.uncoveredCount, "message")} unextracted</span>
			</span>
		{/if}
		<button
			type="button"
			data-testid="ctx-extract"
			onclick={() => void extract()}
			disabled={busy || complete}
			class="flex items-center justify-center rounded-lg border px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
		>
			{busy ? "Running" : "Extract"}
		</button>
	</div>
{/if}
