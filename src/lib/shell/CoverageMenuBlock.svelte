<script lang="ts">
	import { formatTokens } from "$lib/format";
	import { activity } from "$lib/state/activity.svelte";
	import type { SessionCoverage } from "@/src/core";


	let { chatId }: { chatId: string } = $props();
	let coverage = $state<SessionCoverage | null>(null);
	let extracting = $state(false);
	let lastUncovered: number | null = null;

	async function load() {
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}`);
			if (!res.ok) return;
			const body = (await res.json()) as { coverage?: SessionCoverage | null };
			const next = body.coverage ?? null;
			if (!next) return;
			if (next.running || (lastUncovered !== null && next.uncoveredTokens !== lastUncovered)) extracting = false;
			lastUncovered = next.uncoveredTokens;
			coverage = next;
		} catch {
		}
	}

	$effect(() => {
		lastUncovered = null;
		extracting = false;
		void load();
	});

	$effect(() => {
		if (coverage?.running !== true && !extracting) return;
		const timer = setInterval(() => void load(), 2000);
		return () => clearInterval(timer);
	});

	async function extract() {
		extracting = true;
		activity.refresh();
		try {
			const res = await fetch("/api/graph/coverage/extract", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ chatId }),
			});
			if (!res.ok && res.status !== 409) extracting = false;
		} catch {
			extracting = false;
		}
		void load();
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
				<span class="tabular-nums text-muted-foreground">{coverage.uncoveredCount} message{coverage.uncoveredCount === 1 ? "" : "s"} unextracted</span>
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
