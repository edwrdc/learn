<script lang="ts">
	import type { Snippet } from "svelte";
	import { modalLayer } from "./layer";

	/** A destructive confirmation: a title, a body, a failure line with a
	 *  retry, and Cancel / the action. Test ids derive from `ids`
	 *  (`<ids>-cancel`, `-confirm`, `-retry`, `-failure`). */
	let {
		label,
		testid,
		ids,
		title,
		action = "Delete",
		busy,
		busyLabel,
		failure,
		onConfirm,
		onClose,
		children,
	}: {
		label: string;
		testid: string;
		ids: string;
		title: string;
		action?: string;
		busy: boolean;
		/** The action button's label while `busy` ("Deleting…"). */
		busyLabel: string;
		failure: string | null;
		onConfirm: () => void;
		onClose: () => void;
		children: Snippet;
	} = $props();
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {@attach modalLayer(onClose, () => { if (!busy) onClose(); })}>
	<div role="dialog" aria-modal="true" aria-label={label} data-testid={testid} tabindex={-1} class="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl">
		<h2 class="text-sm font-semibold text-destructive">{title}</h2>
		{@render children()}
		{#if failure}
			<div role="alert" data-testid="{ids}-failure" class="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs">
				<span class="text-foreground">{failure}</span>
				<button type="button" data-testid="{ids}-retry" onclick={onConfirm} disabled={busy} class="ml-3 text-xs text-foreground underline-offset-2 hover:underline disabled:opacity-40">Try again</button>
			</div>
		{/if}
		<div class="mt-4 flex justify-end gap-2">
			<button type="button" data-testid="{ids}-cancel" onclick={onClose} disabled={busy} class="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40">Cancel</button>
			<button type="button" data-testid="{ids}-confirm" onclick={onConfirm} disabled={busy} class="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40">{busy ? busyLabel : action}</button>
		</div>
	</div>
</div>
