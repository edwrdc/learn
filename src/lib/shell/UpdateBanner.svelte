<script lang="ts">
	import { onMount } from "svelte";

	let ready = $state<{ status: string; version: string | null } | null>(null);

	onMount(() => window.lh?.onUpdateStatus?.((status) => {
		if (status?.status === "downloaded") ready = status;
	}));
</script>

{#if ready}
	<div
		data-testid="update-banner"
		class="fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 shadow-lg"
	>
		<div class="text-sm">
			<span class="font-medium">LearnHarness {ready.version ?? "update"} is ready</span>
			<span class="text-muted-foreground"> — restart to finish installing.</span>
		</div>
		<button
			type="button"
			onclick={() => window.lh?.installUpdate?.()}
			class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent/80"
		>
			Restart
		</button>
	</div>
{/if}
