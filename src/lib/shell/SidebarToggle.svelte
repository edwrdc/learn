<script lang="ts">
	import { PanelLeftOpen } from "@lucide/svelte";
	import { hint } from "$lib/hint";
	import { sidebar } from "$lib/state/sidebar.svelte";
</script>

<span
	class="sidebar-motion lh-no-drag relative flex h-9 shrink-0 overflow-hidden duration-200 {sidebar.open
		? 'w-0 -mr-3'
		: 'w-9 mr-0 lh-closed-toggle'}"
>
	<button
		type="button"
		aria-label="Open sidebar"
		aria-hidden={sidebar.open}
		tabindex={sidebar.open ? -1 : 0}
		onclick={() => sidebar.toggle()}
		{@attach hint("Open sidebar", { action: "toggle-sidebar" })}
		class="sidebar-motion inline-flex size-9 items-center justify-center rounded-md transition-colors hover:bg-accent duration-200 {sidebar.open
			? 'pointer-events-none opacity-0'
			: 'opacity-100'}"
	>
		<PanelLeftOpen class="size-4" />
	</button>
</span>
