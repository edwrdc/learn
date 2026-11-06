<script lang="ts">
	import { fetchGraphRead, ringFill } from "./coverage";
	import type { SessionCoverage } from "@/src/core";
	import { formatTokens, timeAgo } from "$lib/format";
	import { hint } from "$lib/hint";
	import { activity } from "$lib/state/activity.svelte";
	import { watchSettings } from "$lib/state/settings-signal";


	let { chatId, refreshKey = 0 }: { chatId: string; refreshKey?: number } = $props();
	let graph = $state<{ enabled: boolean; chunkTokens: number } | null>(null);
	let coverage = $state<SessionCoverage | null>(null);
	let open = $state(false);
	let nonce = $state(0);
	let root = $state<HTMLDivElement | null>(null);

	async function fetchGraph(): Promise<void> {
		const read = await fetchGraphRead();
		if (read) graph = read;
	}

	async function fetchCoverage(): Promise<void> {
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}`);
			if (!res.ok) return;
			const body = (await res.json()) as { coverage?: SessionCoverage | null };
			coverage = body.coverage ?? null;
		} catch {
		}
	}

	const runHere = $derived(activity.feed.extractions.some((run) => run.chatId === chatId));

	$effect(() => {
		void nonce;
		void fetchGraph();
	});
	$effect(() => {
		void refreshKey;
		void nonce;
		void runHere;
		void fetchCoverage();
	});
	$effect(() => watchSettings((section) => {
		if (section === "graph") nonce += 1;
	}));
	$effect(() => {
		if (coverage?.running !== true) return;
		const timer = setInterval(() => void fetchCoverage(), 2000);
		return () => clearInterval(timer);
	});
	$effect(() => {
		if (!open || typeof document === "undefined") return;
		const onPointerDown = (event: PointerEvent) => {
			if (root && !root.contains(event.target as Node)) open = false;
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			open = false;
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	});

	const fill = $derived(graph && coverage ? ringFill(coverage.uncoveredTokens, graph.chunkTokens) : 0);
	const C = 2 * Math.PI * 6;
</script>

{#if graph?.enabled && coverage}
	<div bind:this={root} class="lh-no-drag relative shrink-0">
		<button
			type="button"
			data-testid="coverage-ring"
			onclick={() => (open = !open)}
			aria-label="Extraction coverage"
			aria-expanded={open}
			{@attach hint("How much of this session isn't mapped yet", { side: "bottom" })}
			class="relative flex size-5 cursor-pointer items-center justify-center transition-opacity hover:opacity-80"
		>
			<svg viewBox="0 0 16 16" class={coverage.running ? "size-full animate-pulse" : "size-full"} aria-hidden="true">
				<circle cx="8" cy="8" r="6" fill="none" stroke-width="2.5" class="stroke-border" />
				<circle cx="8" cy="8" r="6" fill="none" stroke-width="2.5" class="stroke-foreground/70" stroke-dasharray="{fill * C} {C}" stroke-linecap="round" transform="rotate(-90 8 8)" />
			</svg>
		</button>
		{#if open}
			<div data-testid="coverage-ring-popover" class="absolute top-full right-0 z-40 mt-1.5 w-64 rounded-xl border bg-card p-3 text-xs shadow-xl">
				<div class="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Extraction coverage</div>
				<div class="flex flex-col gap-1 text-muted-foreground">
					<div class="flex justify-between gap-2"><span>Uncovered</span><span class="tabular-nums text-card-foreground">{formatTokens(coverage.uncoveredTokens)} tokens</span></div>
					<div class="flex justify-between gap-2"><span>Covered</span><span class="tabular-nums text-card-foreground">{formatTokens(coverage.coveredTokens)} tokens</span></div>
					<div class="flex justify-between gap-2"><span>Messages</span><span class="tabular-nums text-card-foreground">{coverage.coveredCount} / {coverage.totalMessages}</span></div>
					<div class="flex justify-between gap-2"><span>Chunk threshold</span><span class="tabular-nums text-card-foreground">{formatTokens(graph.chunkTokens)} tokens</span></div>
					<div class="flex justify-between gap-2"><span>Last extraction</span><span class="tabular-nums text-card-foreground">{coverage.lastFoldedAt ? timeAgo(coverage.lastFoldedAt) : "—"}</span></div>
					{#if coverage.running}
						<div class="flex justify-between gap-2" data-testid="coverage-ring-running"><span>Status</span><span class="text-card-foreground">extracting…</span></div>
					{/if}
				</div>
			</div>
		{/if}
	</div>
{/if}
