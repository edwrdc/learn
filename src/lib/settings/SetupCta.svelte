<script lang="ts">
	import { noProviderKey } from "$lib/state/keys.svelte";

	/** The setup nudge: a missing provider key first, then unconfigured models. */
	let { configured, onOpen, wrap = "" }: { configured: boolean; onOpen: () => void; wrap?: string } = $props();

	const BUTTON = "cursor-pointer rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent";
</script>

{#if noProviderKey.value}
	<div class={wrap || "contents"}>
		<button type="button" data-testid="setup-cta-keys" onclick={onOpen} class={BUTTON}>Add a provider key</button>
	</div>
{:else if !configured}
	<div class={wrap || "contents"}>
		<button type="button" data-testid="setup-cta" onclick={onOpen} class={BUTTON}>Set up your models</button>
	</div>
{/if}
