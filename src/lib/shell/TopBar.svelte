<script lang="ts">
	import type { Snippet } from "svelte";
	import SidebarToggle from "$lib/shell/SidebarToggle.svelte";

	let {
		drag = true,
		onmousedown,
		children,
	}: { drag?: boolean; onmousedown?: (event: MouseEvent) => void; children?: Snippet } = $props();
</script>

<!-- The mousedown only blurs a field inside the bar; the bar is not a control. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<header
	{onmousedown}
	class="{drag ? 'lh-drag ' : ''}lh-wco-gutter flex h-15 select-none items-center gap-3 border-b border-border px-3"
>
	<SidebarToggle />
	{@render children?.()}
</header>
