<script lang="ts">
import { untrack } from "svelte";
	let {
		value,
		placeholder,
		onCommit,
		ariaLabel,
		testid,
		type = "text",
	}: {
		value: string;
		placeholder?: string;
		onCommit: (next: string) => void;
		ariaLabel: string;
		testid?: string;
		type?: "text" | "number";
	} = $props();

	let draft = $state(untrack(() => value));
	let editing = $state(false);

	$effect(() => {
		if (!editing) draft = value;
	});

	function commit() {
		if (!editing) return;
		editing = false;
		const next = draft.trim();
		if (next !== value) onCommit(next);
	}
</script>

<input
	{type}
	value={editing ? draft : value}
	{placeholder}
	aria-label={ariaLabel}
	data-testid={testid}
	oninput={(event) => {
		editing = true;
		draft = (event.currentTarget as HTMLInputElement).value;
	}}
	onblur={commit}
	onkeydown={(event) => {
		if (event.key === "Enter") (event.currentTarget as HTMLInputElement).blur();
		if (event.key === "Escape") {
			editing = false;
			(event.currentTarget as HTMLInputElement).blur();
		}
	}}
	class="h-7 w-40 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
/>
