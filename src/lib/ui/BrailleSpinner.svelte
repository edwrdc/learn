<script lang="ts">
	let { label = "Working" }: { label?: string } = $props();

	const FRAMES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
		[[1, 1], [1, 3], [3, 1]],
		[[1, 1], [3, 1], [3, 3]],
		[[1, 1], [3, 1], [3, 3], [3, 5]],
		[[3, 1], [3, 3], [3, 5]],
		[[1, 5], [3, 1], [3, 3], [3, 5]],
		[[1, 5], [3, 3], [3, 5]],
		[[1, 3], [1, 5], [3, 5]],
		[[1, 1], [1, 3], [1, 5], [3, 5]],
		[[1, 1], [1, 3], [1, 5]],
		[[1, 1], [1, 3], [1, 5], [3, 1]],
	];
</script>

<svg
	viewBox="0 0 4 8"
	data-testid="braille-spinner"
	role="status"
	aria-label={label}
	class="h-3 w-auto shrink-0 text-foreground"
>
	{#each FRAMES as dots, k (k)}
		<g class="braille-frame" data-frame={k} style={`animation-delay: ${k * 80}ms`}>
			{#each dots as [cx, cy] (`${cx}-${cy}`)}
				<circle {cx} {cy} r={0.8} class="fill-current" />
			{/each}
		</g>
	{/each}
</svg>
