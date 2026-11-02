<script lang="ts">
	import { backdropDismiss } from "$lib/backdrop";
	import { deleteFailureLine } from "./delete-node";

	let {
		nodes,
		onClose,
		onDeleted,
	}: {
		nodes: { id: string; name: string }[] | null;
		onClose: () => void;
		onDeleted: (nodeIds: string[], graphRevision: number) => void;
	} = $props();

	let busy = $state(false);
	let failure = $state<{ code: string; error: string } | null>(null);

	$effect(() => {
		if (!nodes || nodes.length === 0) {
			busy = false;
			failure = null;
		}
	});
	$effect(() => {
		if (!nodes || nodes.length === 0 || typeof document === "undefined") return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			onClose();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	});

	async function run() {
		if (!nodes || nodes.length === 0 || busy) return;
		busy = true;
		failure = null;
		const dead: string[] = [];
		let revision = 0;
		try {
			for (const node of nodes) {
				const res = await fetch(`/api/graph/nodes/${encodeURIComponent(node.id)}`, { method: "DELETE" });
				const body = (await res.json()) as { error?: string; code?: string; graphRevision?: number };
				if (!res.ok) {
					failure = { code: body.code ?? "error", error: body.error ?? `Delete failed (${res.status})` };
					busy = false;
					if (dead.length > 0) onDeleted(dead, revision);
					return;
				}
				dead.push(node.id);
				revision = body.graphRevision ?? revision;
			}
			onDeleted(dead, revision);
		} catch {
			failure = { code: "network", error: "Delete failed — network error. Try again." };
			busy = false;
			if (dead.length > 0) onDeleted(dead, revision);
		}
	}
</script>

{#if nodes && nodes.length > 0}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {@attach backdropDismiss(() => { if (!busy) onClose(); })}>
		<div role="dialog" aria-modal="true" aria-label="Delete node" data-testid="delete-node-dialog" tabindex={-1} class="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl">
			<h2 class="text-sm font-semibold text-destructive">{nodes.length === 1 ? "Delete node?" : `Delete ${nodes.length} nodes?`}</h2>
			<div class="mt-1.5">
				{#if nodes.length === 1}
					<code data-testid="node-name-code" class="font-mono text-sm text-foreground">{nodes[0]?.name}</code>
				{:else}
					<code data-testid="node-names-code" class="font-mono text-sm text-foreground">{nodes.slice(0, 8).map((n) => n.name).join(", ")}{nodes.length > 8 ? `, and ${nodes.length - 8} more` : ""}</code>
				{/if}
			</div>
			<p class="mt-2 text-sm text-muted-foreground" data-testid="node-permanence-line">
				{nodes.length === 1 ? "This permanently deletes the node — this cannot be undone." : `This permanently deletes all ${nodes.length} nodes — this cannot be undone.`}
			</p>
			{#if failure}
				<div role="alert" data-testid="node-delete-failure" class="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs">
					<span class="text-foreground">{deleteFailureLine(failure)}</span>
					<button type="button" data-testid="node-delete-retry" onclick={() => void run()} disabled={busy} class="ml-3 text-xs text-foreground underline-offset-2 hover:underline disabled:opacity-40">Try again</button>
				</div>
			{/if}
			<div class="mt-4 flex justify-end gap-2">
				<button type="button" data-testid="node-delete-cancel" onclick={onClose} disabled={busy} class="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40">Cancel</button>
				<button type="button" data-testid="node-delete-confirm" onclick={() => void run()} disabled={busy} class="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40">{busy ? "Deleting…" : "Delete"}</button>
			</div>
		</div>
	</div>
{/if}
