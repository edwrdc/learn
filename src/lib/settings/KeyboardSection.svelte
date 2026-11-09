<script lang="ts">
	import { KEYBOARD_ACTIONS, eventBinding, formatBinding, loadOverrides, saveOverrides, type KeyAction, type KeyScope } from "@/src/settings/model";
	import Controls from "./Controls.svelte";
	import { nextOverrides } from "./compose";

	const SCOPES: Array<{ scope: KeyScope; label: string }> = [
		{ scope: "global", label: "Global" },
		{ scope: "chat", label: "Chat" },
		{ scope: "graph", label: "Graph" },
	];

	let overrides = $state<Partial<Record<KeyAction, string>>>({});
	let rebinding = $state<KeyAction | null>(null);
	let nonce = $state(0);

	$effect(() => {
		void nonce;
		overrides = loadOverrides();
	});

	$effect(() => {
		if (!rebinding || typeof window === "undefined") return;
		const onKey = (event: KeyboardEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (event.key === "Escape") {
				rebinding = null;
				return;
			}
			if (event.key === "Control" || event.key === "Meta" || event.key === "Alt" || event.key === "Shift") return;
			const binding = eventBinding(event);
			if (!binding) return;
			saveOverrides(nextOverrides(loadOverrides(), rebinding!, binding));
			rebinding = null;
			nonce += 1;
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	});

	function resetOne(id: KeyAction) {
		saveOverrides(nextOverrides(loadOverrides(), id, null));
		nonce += 1;
	}
	function resetAll() {
		saveOverrides({});
		nonce += 1;
	}
</script>

{#each SCOPES as { scope, label } (scope)}
	{@const actions = KEYBOARD_ACTIONS.filter((action) => action.scope === scope)}
	{#if actions.length > 0}
		<div data-testid={`kbd-scope-${scope}`}>
			<p class="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">{label}</p>
			<div class="flex flex-col gap-2">
				{#each actions as definition (definition.id)}
					{@const effective = overrides[definition.id] ?? definition.binding}
					<Controls kind="row" label={definition.label} hint={definition.displayOnly ? "Fixed — part of this screen" : undefined} testid={`kbd-row-${definition.id}`}>
						<span class="flex items-center gap-2">
							<kbd class="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-ui text-xs">{rebinding === definition.id ? "Press keys…" : formatBinding(effective)}</kbd>
							{#if !definition.displayOnly}
								{#if rebinding === definition.id}
									<button type="button" onclick={() => (rebinding = null)} class="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline">Cancel</button>
								{:else}
									<button type="button" onclick={() => (rebinding = definition.id)} data-testid={`kbd-rebind-${definition.id}`} class="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Rebind</button>
									{#if overrides[definition.id] !== undefined}
										<button type="button" onclick={() => resetOne(definition.id)} data-testid={`kbd-reset-${definition.id}`} class="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline">Reset</button>
									{/if}
								{/if}
							{/if}
						</span>
					</Controls>
				{/each}
			</div>
		</div>
	{/if}
{/each}
<div class="mt-1 flex items-center justify-between">
	<span class="text-xs text-muted-foreground/70">Stored on this device (lh:keymap) — overrides only.</span>
	<button type="button" onclick={resetAll} data-testid="kbd-reset-all" class="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Reset all to defaults</button>
</div>
