<script lang="ts">
	import { ArrowRight, CornerDownLeft, Square } from "@lucide/svelte";
	import { focusOnMount } from "$lib/dom";
	import { enterAction } from "./chat-logic";

	let {
		busy,
		value,
		onChange,
		onSend,
		onStop,
		canSend,
		autoFocus = false,
		onEscape,
		placeholder = "Ask, answer, or steer the lesson…",
		nextProblem = false,
		onNext,
	}: {
		busy: boolean;
		value: string;
		onChange: (v: string) => void;
		onSend: () => void;
		onStop: () => void;
		canSend: boolean;
		autoFocus?: boolean;
		onEscape?: () => void;
		placeholder?: string;
		nextProblem?: boolean;
		onNext?: () => void;
	} = $props();

	function act() {
		const action = enterAction({ busy, canSend, nextProblem });
		if (action === "send") onSend();
		else if (action === "stop") onStop();
		else if (action === "next") onNext?.();
	}
</script>

<form
	data-testid="composer"
	class="flex items-end gap-1.5 p-1.5"
	onsubmit={(event) => {
		event.preventDefault();
		act();
	}}
>
	<textarea
		{value}
		oninput={(event) => onChange((event.currentTarget as HTMLTextAreaElement).value)}
		onkeydown={(event) => {
			if (event.key === "Escape" && onEscape) {
				event.preventDefault();
				event.stopPropagation();
				onEscape();
				return;
			}
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey || !event.shiftKey)) {
				event.preventDefault();
				act();
			}
		}}
		{placeholder}
		{@attach focusOnMount(autoFocus)}
		rows={1}
		class="field-sizing-content lh-input max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
	></textarea>
	{#if nextProblem && !busy && !canSend}
		<button
			type="submit"
			data-testid="next-problem-button"
			aria-label="Next problem"
			class="flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-[10px] bg-green-600 px-4 font-ui text-xs font-medium uppercase tracking-wide text-white transition-colors hover:bg-green-500"
		>
			Next problem
			<ArrowRight class="size-4" />
		</button>
	{:else}
		<button
			type="submit"
			aria-label={busy && !canSend ? "Stop" : "Send"}
			disabled={!busy && !canSend}
			class="flex size-10 shrink-0 items-center justify-center rounded-[10px] transition-colors {busy && !canSend
				? 'bg-secondary text-foreground hover:bg-accent'
				: 'bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40'}"
		>
			{#if busy && !canSend}
				<Square class="size-4" />
			{:else}
				<CornerDownLeft class="size-5" />
			{/if}
		</button>
	{/if}
</form>
