<script lang="ts">
	import { codeKeydown } from "./code-input";

	let { value, onChange, onSubmit, onEscape }: {
		value: string;
		onChange: (value: string) => void;
		onSubmit: () => void;
		onEscape?: () => void;
	} = $props();
	let open = $state(false);
</script>

{#if open || value}
	<div class="border-t border-border/60 px-2.5 py-2">
		<label class="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
			Code
			<textarea
				{value}
				oninput={(event) => onChange(event.currentTarget.value)}
				onkeydown={(event) => codeKeydown(event, onChange, onSubmit, onEscape)}
				spellcheck={false}
				autocapitalize="off"
				autocomplete="off"
				wrap="off"
				rows={4}
				class="lh-input mt-1 max-h-64 min-h-24 w-full resize-y bg-transparent font-mono text-sm font-normal normal-case tracking-normal outline-none"
			></textarea>
		</label>
		<p class="text-xs text-muted-foreground">Enter: newline · Tab: 4 spaces · Shift+Tab: leave code · Ctrl/Cmd+Enter: submit</p>
	</div>
{:else}
	<button type="button" onclick={() => (open = true)} class="px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground">Add code</button>
{/if}
