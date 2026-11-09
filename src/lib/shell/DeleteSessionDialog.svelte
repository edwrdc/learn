<script lang="ts">
	import ConfirmDialog from "$lib/ui/ConfirmDialog.svelte";
	import { deleteChat } from "$lib/api/chats";
	import { ApiError } from "$lib/api/http";
	import type { ChatDeleteMode } from "@/src/graph/model";
import type { ChatListItem } from "@/src/session/model";

	let {
		chat,
		onClose,
		onDeleted,
	}: {
		chat: Pick<ChatListItem, "id" | "title"> | null;
		onClose: () => void;
		onDeleted: (id: string, graphRevision: number) => void;
	} = $props();

	let traces = $state(false);
	let busy = $state(false);
	let failure = $state<{ code: string; error: string } | null>(null);

	$effect(() => {
		if (chat === null) {
			traces = false;
			busy = false;
			failure = null;
		}
	});


	async function run() {
		if (!chat || busy) return;
		const mode: ChatDeleteMode = traces ? "delete-nodes" : "preserve-graph";
		busy = true;
		failure = null;
		try {
			const { graphRevision } = await deleteChat(chat.id, mode);
			onDeleted(chat.id, graphRevision);
		} catch (error) {
			failure =
				error instanceof ApiError
					? { code: error.body?.code ?? "error", error: error.message }
					: { code: "network", error: "Delete failed — network error. Try again." };
			busy = false;
		}
	}
</script>

{#if chat}
	<ConfirmDialog label="Delete session" testid="delete-session-dialog" ids="delete" title="Delete session?" {busy} failure={failure?.error ?? null} onConfirm={() => void run()} {onClose}>
		<div class="mt-1.5">
			<code data-testid="session-name-code" class="font-mono text-sm text-foreground">{chat.title}</code>
		</div>
		<p class="mt-2 text-sm text-muted-foreground">
			This permanently removes the session — its messages, background jobs, and extraction records. Everything
			it added to the graph stays unless you check below. This cannot be undone.
		</p>
		<label data-testid="delete-traces" class="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 px-4 py-3">
			<input
				type="checkbox"
				data-testid="delete-traces-checkbox"
				checked={traces}
				onchange={(event) => (traces = (event.currentTarget as HTMLInputElement).checked)}
				disabled={busy}
				class="mt-0.5 size-4 shrink-0 accent-primary"
			/>
			<span class="min-w-0">
				<span class="block text-sm text-foreground">Also remove its graph traces</span>
				<span class="mt-1 block text-xs text-muted-foreground">
					This session’s topics, links, and events leave the graph too. Topics other sessions or imported notes
					also cover survive; topics only this session created are removed entirely.
				</span>
			</span>
		</label>
	</ConfirmDialog>
{/if}
