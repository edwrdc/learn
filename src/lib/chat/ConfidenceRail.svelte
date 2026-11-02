<script lang="ts">
	import { confidenceRailStyle } from "./confidence";

	let { value, class: className = "" }: { value: number; class?: string } = $props();
</script>

<div
	aria-hidden="true"
	data-testid="confidence-rail"
	class="h-1.5 w-full rounded-full border border-border {className}"
	style={confidenceRailStyle(value)}
></div>
