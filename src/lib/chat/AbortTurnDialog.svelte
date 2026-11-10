<script lang="ts">
	import ConfirmDialog from "$lib/ui/ConfirmDialog.svelte";

	type AbortMode = "turn" | "question" | "problem";
	let { mode, onClose, onConfirm, busy = false }: { mode: AbortMode | null; onClose: () => void; onConfirm: (mode: AbortMode) => void; busy?: boolean } = $props();
	const COPY: Record<AbortMode, { title: string; line: string; action: string }> = {
		turn: { title: "Abort this turn?", line: "The partial answer stays in the transcript.", action: "Abort" },
		question: { title: "Dismiss this question?", line: "Skipped — the teacher moves on without it.", action: "Dismiss" },
		problem: { title: "Discard this problem?", line: "The problem is dropped — no solution is revealed.", action: "Discard" },
	};
</script>

{#if mode}
	{@const copy = COPY[mode]}
	<ConfirmDialog label={copy.title} testid="abort-turn-dialog" ids="abort-turn" title={copy.title} action={copy.action} busy={false} failure={null} onConfirm={() => onConfirm(mode)} {onClose}>
		<p class="mt-1.5 text-xs text-muted-foreground" data-testid="abort-turn-line">
			{copy.line}{busy && mode !== "turn" ? " The working turn stops too." : ""}
		</p>
	</ConfirmDialog>
{/if}
