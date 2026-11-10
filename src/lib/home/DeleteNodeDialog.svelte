<script lang="ts">
	import ConfirmDialog from "$lib/ui/ConfirmDialog.svelte";
	import { deleteGraphNode } from "$lib/api/graph";
	import { ApiError, failureMessage } from "$lib/api/http";
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

	async function run() {
		if (!nodes || nodes.length === 0 || busy) return;
		busy = true;
		failure = null;
		const dead: string[] = [];
		let revision = 0;
		try {
			for (const node of nodes) {
				revision = (await deleteGraphNode(node.id)).graphRevision;
				dead.push(node.id);
			}
			onDeleted(dead, revision);
		} catch (error) {
			failure = {
				code: error instanceof ApiError ? (error.body?.code ?? "error") : "network",
				error: failureMessage(error, "Delete failed — network error. Try again."),
			};
			busy = false;
			if (dead.length > 0) onDeleted(dead, revision);
		}
	}
</script>

{#if nodes && nodes.length > 0}
	<ConfirmDialog
		label="Delete node"
		testid="delete-node-dialog"
		ids="node-delete"
		title={nodes.length === 1 ? "Delete node?" : `Delete ${nodes.length} nodes?`}
		{busy}
		busyLabel="Deleting…"
		failure={failure ? deleteFailureLine(failure) : null}
		onConfirm={() => void run()}
		{onClose}
	>
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
	</ConfirmDialog>
{/if}
