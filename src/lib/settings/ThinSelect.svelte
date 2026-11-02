<script lang="ts">
	import type { Snippet } from "svelte";
	let {
		value,
		onChange,
		ariaLabel,
		testid,
		disabled = false,
		children,
	}: { value: string; onChange: (next: string) => void; ariaLabel: string; testid?: string; disabled?: boolean; children?: Snippet } = $props();
</script>

<select
	{value}
	aria-label={ariaLabel}
	data-testid={testid}
	{disabled}
	onchange={(event) => onChange((event.currentTarget as HTMLSelectElement).value)}
	class="h-7 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none"
>
	{@render children?.()}
</select>
