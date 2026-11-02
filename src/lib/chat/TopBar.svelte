<script lang="ts">
	import type { Snippet } from "svelte";
	import SidebarToggle from "./SidebarToggle.svelte";
	import { onMouseDown as mouseDown } from "$lib/dom";

	let {
		drag = true,
		onMouseDown,
		children,
	}: { drag?: boolean; onMouseDown?: (event: MouseEvent) => void; children?: Snippet } = $props();
</script>

<header
	{@attach mouseDown(onMouseDown)}
	class="{drag ? 'lh-drag ' : ''}lh-wco-gutter flex h-15 select-none items-center gap-3 border-b border-border px-3"
>
	<SidebarToggle />
	{@render children?.()}
</header>
