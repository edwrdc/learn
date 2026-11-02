<script lang="ts">
	let { class: className = "" }: { class?: string } = $props();
</script>

<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class={className} aria-hidden="true">
	<circle cx="12" cy="12" r="10" />
	<path d="M12 18a6 6 0 0 0 0-12v12z" fill="currentColor" stroke="none" />
</svg>
