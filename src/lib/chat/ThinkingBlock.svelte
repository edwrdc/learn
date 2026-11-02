<script lang="ts">
import { untrack } from "svelte";
	import { ChevronDown } from "@lucide/svelte";
	import { cn } from "$lib/utils";

	let {
		label = "YOUR THINKING",
		text,
		testId,
		defaultOpen = false,
		inCard = false,
	}: {
		label?: string;
		text: string;
		testId?: string;
		defaultOpen?: boolean;
		inCard?: boolean;
	} = $props();

	import { userThinking } from "./thinking-store.svelte";
	import { blurAfterPointerClick } from "./enter-submits";

	let open = $state(untrack(() => userThinking.value ?? defaultOpen));
	$effect(() => {
		if (userThinking.value !== null) open = userThinking.value;
	});
</script>

<div
	data-testid={testId}
	class={cn(
		"lh-card-enter my-2 w-full border-l-[calc(3ch-14px)] border-muted-foreground/30 py-1 pl-[14px] pr-4 font-ui text-xs",
		inCard ? "" : "bg-card",
	)}
>
	<button
		type="button"
		data-testid={testId ? `${testId}-trigger` : undefined}
		onclick={(event) => {
			open = !open;
			blurAfterPointerClick(event);
		}}
		aria-expanded={open}
		class="flex w-full items-center gap-2 font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
	>
		{label}
		<ChevronDown class={cn("size-4 shrink-0 transition-transform", open ? "rotate-180" : "rotate-0")} />
	</button>
	{#if open}
		<span class="lh-prose mt-1.5 block whitespace-pre-wrap text-[15px] italic text-foreground/50">{text}</span>
	{/if}
</div>
