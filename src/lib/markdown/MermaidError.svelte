<script lang="ts">
	let { chart, error, retry }: { chart: string; error: string; retry: () => void } = $props();
</script>

<div
	class="my-4 rounded-xl border border-destructive/40 bg-destructive/5 p-4"
	data-streamdown="mermaid-error"
>
	<p class="text-sm font-medium text-destructive">Diagram failed to render</p>
	<p class="mt-1 font-mono text-xs break-words text-muted-foreground">{error}</p>
	<details class="mt-3">
		<summary class="cursor-pointer text-xs text-muted-foreground">Show diagram source</summary>
		<pre class="mt-2 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs text-foreground">{chart}</pre>
	</details>
	<button
		type="button"
		class="mt-3 inline-flex h-8 items-center justify-center rounded-md border bg-background px-3 text-sm font-medium hover:bg-accent"
		onclick={retry}
	>
		Retry
	</button>
</div>
