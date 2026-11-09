<script lang="ts">
	import { deleteChat } from "$lib/api/chats";
	import { ApiError } from "$lib/api/http";
	import { tick } from "svelte";
	import type { ChatDeleteMode } from "@/src/graph/model";
import type { ChatListItem } from "@/src/session/model";
	import { backdropDismiss } from "$lib/backdrop";

	let {
		chat,
		onClose,
		onDeleted,
	}: {
		chat: Pick<ChatListItem, "id" | "title"> | null;
		onClose: () => void;
		onDeleted: (id: string, mode: ChatDeleteMode, graphRevision: number) => void;
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

	$effect(() => {
		if (chat === null || typeof document === "undefined") return;
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
		if (!chat || busy) return;
		const mode: ChatDeleteMode = traces ? "delete-nodes" : "preserve-graph";
		busy = true;
		failure = null;
		try {
			const { graphRevision } = await deleteChat(chat.id, mode);
			onDeleted(chat.id, mode, graphRevision);
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
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
		{@attach backdropDismiss(() => { if (!busy) onClose(); })}
	>
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Delete session"
			data-testid="delete-session-dialog"
			tabindex={-1}
			class="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 class="text-sm font-semibold text-destructive">Delete session?</h2>
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
			{#if failure}
				<div role="alert" data-testid="delete-failure" class="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs">
					<span class="text-foreground">{failure.error}</span>
					<button
						type="button"
						data-testid="delete-retry"
						onclick={() => void run()}
						disabled={busy}
						class="ml-3 text-xs text-foreground underline-offset-2 hover:underline disabled:opacity-40"
					>
						Try again
					</button>
				</div>
			{/if}
			<div class="mt-4 flex justify-end gap-2">
				<button
					type="button"
					data-testid="delete-cancel"
					onclick={onClose}
					disabled={busy}
					class="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
				>
					Cancel
				</button>
				<button
					type="button"
					data-testid="delete-confirm"
					onclick={() => void run()}
					disabled={busy}
					class="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40"
				>
					{busy ? "Deleting…" : "Delete"}
				</button>
			</div>
		</div>
	</div>
{/if}
