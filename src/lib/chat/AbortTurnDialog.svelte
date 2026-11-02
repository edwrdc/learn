<script lang="ts">
	import { backdropDismiss } from "$lib/backdrop";

	export type AbortMode = "turn" | "question" | "problem";
	let { mode, onClose, onConfirm, busy = false }: { mode: AbortMode | null; onClose: () => void; onConfirm: (mode: AbortMode) => void; busy?: boolean } = $props();
	const COPY: Record<AbortMode, { title: string; line: string; action: string }> = {
		turn: { title: "Abort this turn?", line: "The partial answer stays in the transcript.", action: "Abort" },
		question: { title: "Dismiss this question?", line: "Skipped — the teacher moves on without it.", action: "Dismiss" },
		problem: { title: "Discard this problem?", line: "The problem is dropped — no solution is revealed.", action: "Discard" },
	};

	$effect(() => {
		if (mode === null || typeof document === "undefined") return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			onClose();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	});
</script>

{#if mode}
	<div
		role="dialog"
		aria-modal="true"
		aria-label={COPY[mode].title}
		data-testid="abort-turn-dialog"
		class="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
		{@attach backdropDismiss(onClose)}
	>
		<div class="mx-4 w-full max-w-sm rounded-xl border bg-card p-5 shadow-lg">
			<h2 class="text-sm font-semibold text-card-foreground" data-testid="abort-turn-title">{COPY[mode].title}</h2>
			<p class="mt-1.5 text-xs text-muted-foreground" data-testid="abort-turn-line">
				{COPY[mode].line}{busy && mode !== "turn" ? " The working turn stops too." : ""}
			</p>
			<div class="mt-4 flex justify-end gap-2">
				<button type="button" data-testid="abort-turn-cancel" onclick={onClose} class="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">Cancel</button>
				<button
					type="button"
					data-testid="abort-turn-confirm"
					onclick={() => onConfirm(mode!)}
					class="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20"
				>{COPY[mode].action}</button>
			</div>
		</div>
	</div>
{/if}
