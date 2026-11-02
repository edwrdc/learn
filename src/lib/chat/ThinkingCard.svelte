<script lang="ts">
	import ThinkingBlock from "./ThinkingBlock.svelte";
	let { data }: { data: { problemCallId: string; text: string } } = $props();
</script>

<ThinkingBlock testId="thinking-card" label="YOUR THINKING" text={data.text} defaultOpen />
