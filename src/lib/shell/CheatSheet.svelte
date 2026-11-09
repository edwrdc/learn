<script lang="ts">
	import { bindingForAction, formatBinding, KEYBOARD_ACTIONS } from "@/src/settings/model";
	import { backdropDismiss } from "$lib/backdrop";
	import { cheatSheet } from "$lib/state/dialogs.svelte";

	const scopes = ["global", "chat", "graph"] as const;
	const labels: Record<(typeof scopes)[number], string> = { global: "Global", chat: "Chat", graph: "Graph view" };

	$effect(() => {
		if (!cheatSheet.open || typeof document === "undefined") return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			cheatSheet.open = false;
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	});
</script>

{#if cheatSheet.open}
	<div
		data-testid="cheat-sheet"
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
		{@attach backdropDismiss(() => (cheatSheet.open = false))}
	>
		<div
			class="max-h-[80vh] w-full max-w-[36rem] overflow-y-auto rounded-xl border bg-card p-5 shadow-2xl"
		>
			<div class="mb-4 flex items-baseline justify-between">
				<span class="text-sm font-medium text-card-foreground">Keyboard shortcuts</span>
				<span class="text-xs text-muted-foreground">Esc to close</span>
			</div>
			{#each scopes as scope (scope)}
				{@const actions = KEYBOARD_ACTIONS.filter((action) => action.scope === scope)}
				{#if actions.length > 0}
					<div class="mb-4">
						<div class="mb-1.5 text-xs uppercase tracking-widest text-muted-foreground/70">{labels[scope]}</div>
						<div class="flex flex-col gap-1">
							{#each actions as action (action.id)}
								<div class="flex items-center justify-between gap-4 text-sm">
									<span class="text-muted-foreground">{action.label}</span>
									<kbd class="rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-card-foreground">{formatBinding(bindingForAction(action.id))}</kbd>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			{/each}
		</div>
	</div>
{/if}
