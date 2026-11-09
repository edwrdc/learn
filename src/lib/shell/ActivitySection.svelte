<script lang="ts">
	import { Activity, Bot, FileText, PenTool, Play, Search, Square, Waypoints } from "@lucide/svelte";
	import { jobAgentLabel } from "@/src/tools/model";
	import { formatUsd } from "$lib/format";
	import { activity } from "$lib/state/activity.svelte";
	import { formatElapsed, toBlobs, type ActivityBlob } from "$lib/state/activity";
	import { goto } from "$app/navigation";

	let openBlob = $state<string | null>(null);
	let abortStates = $state<Record<string, "pending" | "failed">>({});
	let now = $state(Date.now());

	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	const blobs = $derived(toBlobs(activity.feed));
	const totalCost = $derived.by(() => {
		const priced = blobs.map((b) => b.cost).filter((c): c is number => c !== null);
		return priced.length === 0 ? null : priced.reduce((a, c) => a + c, 0);
	});

	function labelOf(blob: ActivityBlob): string {
		if (blob.process === "extraction") return `Extraction — ${blob.phase ?? "running"}`;
		return blob.jobKind ? jobAgentLabel(blob.jobKind) : "Sub-agent";
	}

	async function abort(blob: ActivityBlob) {
		abortStates = { ...abortStates, [blob.id]: "pending" };
		try {
			const res = await fetch("/api/activity/abort", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					kind: blob.process,
					id: blob.process === "extraction" ? blob.chatId : blob.id,
				}),
			});
			if (!res.ok) {
				if (res.status === 404 || res.status === 409) {
					activity.refresh();
					const { [blob.id]: _drop, ...rest } = abortStates;
					abortStates = rest;
					return;
				}
				throw new Error(String(res.status));
			}
			activity.refresh();
		} catch {
			abortStates = { ...abortStates, [blob.id]: "failed" };
		}
	}
</script>

<section data-testid="activity-section" class="border-t border-border px-3 pb-3 pt-2">
	<div class="mb-1 flex items-center gap-1.5 text-xs uppercase tracking-widest text-muted-foreground/70">
		<Activity class="size-3" />
		Background agents
		{#if blobs.length > 0}
			<span class="ml-auto tabular-nums" data-testid="activity-total-cost" title="Total running cost (inferred)">
				{totalCost === null ? "—" : formatUsd(totalCost)}
			</span>
		{/if}
	</div>
	{#if blobs.length > 0}
		<div class="flex max-h-[40dvh] flex-col gap-1 overflow-y-auto">
			{#each blobs as blob (blob.id)}
				{@const Icon = blob.process === "extraction" ? Waypoints : blob.jobKind === "research" ? Search : blob.jobKind === "demo" ? Play : blob.jobKind === "visual" ? PenTool : blob.jobKind === "pdf" ? FileText : Bot}
				{@const label = labelOf(blob)}
				<div
					data-testid={`activity-blob-${blob.process}`}
					class="relative rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-accent"
				>
					<button
						type="button"
						onclick={() => (openBlob = openBlob === blob.id ? null : blob.id)}
						aria-expanded={openBlob === blob.id}
						class="flex w-full items-center gap-2 pr-7 text-left"
					>
						<Icon class="size-3.5 shrink-0 text-muted-foreground" />
						<span class="min-w-0 flex-1">
							<span class="block truncate font-medium text-card-foreground">{blob.title}</span>
							{#if blob.activity}
								<span class="block truncate text-muted-foreground" title={blob.activity}>{blob.activity}</span>
							{:else}
								<span class="block truncate text-muted-foreground/80">{label}</span>
							{/if}
						</span>
						<span class="flex shrink-0 items-center gap-2 tabular-nums text-muted-foreground">
							<span data-testid="activity-blob-cost">{blob.cost === null ? "—" : formatUsd(blob.cost)}</span>
							<span data-testid="activity-blob-elapsed">{formatElapsed(now - blob.startedAt)}</span>
						</span>
					</button>
					<button
						type="button"
						data-testid="activity-abort"
						onclick={() => void abort(blob)}
						disabled={abortStates[blob.id] !== undefined}
						title={abortStates[blob.id] === "failed" ? "Abort failed — try again" : "End this background process"}
						aria-label={`End ${label} in ${blob.title}`}
						class="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
					>
						<Square class="size-3" />
					</button>
					{#if openBlob === blob.id}
						<div data-testid="activity-blob-detail" class="mt-1 flex flex-col gap-1 rounded-lg bg-accent/40 p-2 text-muted-foreground">
							<div class="mb-1.5 flex items-center gap-2">
								<Icon class="size-3.5 text-muted-foreground" />
								<span class="font-medium">{label}</span>
								<span class="ml-auto tabular-nums text-muted-foreground">{formatElapsed(now - blob.startedAt)}</span>
							</div>
							<div class="flex flex-col gap-1 text-muted-foreground">
								<div class="truncate text-card-foreground" title={blob.title}>{blob.title}</div>
								{#if blob.activity}<div class="break-words">{blob.activity}</div>{/if}
								<div class="flex justify-between gap-2">
									<span>Cost</span>
									<span class="tabular-nums text-card-foreground">{blob.cost === null ? "—" : formatUsd(blob.cost)}</span>
								</div>
								<div class="flex justify-between gap-2">
									<span>Context</span>
									<span class="tabular-nums text-card-foreground" data-testid="activity-blob-context">
										{blob.context === null ? "—" : `${blob.context.used} / ${blob.context.limit}`}
									</span>
								</div>
								{#if blob.model}
									<div class="flex justify-between gap-2"><span>Model</span><span class="truncate text-card-foreground">{blob.model}</span></div>
								{/if}
								{#if blob.steps !== undefined}
									<div class="flex justify-between gap-2"><span>Steps</span><span class="tabular-nums text-card-foreground">{blob.steps}</span></div>
								{/if}
								<a href={`/chat/${blob.chatId}`} class="text-primary hover:underline" onclick={(e) => { e.preventDefault(); void goto(`/chat/${blob.chatId}`); }}>Open session →</a>
							</div>
							<div class="mt-2 text-muted-foreground/80">
								{abortStates[blob.id] === "failed" ? "Abort failed — try again" : abortStates[blob.id] === "pending" ? "Stopping…" : ""}
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</section>
