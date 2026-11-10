<script lang="ts">
	import { blurAfterPointerClick } from "$lib/ui/enter-submits";
	import { copyText } from "./copy";

	let {
		getText,
		label,
		class: className = "",
	}: { getText: () => string; label: string; class?: string } = $props();

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function onClick(event: MouseEvent) {
		blurAfterPointerClick(event);
		const ok = await copyText(getText());
		if (!ok) return;
		copied = true;
		clearTimeout(timer);
		timer = setTimeout(() => (copied = false), 1500);
	}
</script>

<span class="relative inline-flex {className}">
	<button
		type="button"
		aria-label={label}
		data-testid="md-copy"
		class="flex size-6 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/md:opacity-100"
		onclick={onClick}
	>
		{#if copied}
			<svg viewBox="0 0 24 24" class="size-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
		{:else}
			<svg viewBox="0 0 24 24" class="size-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
		{/if}
	</button>
</span>
