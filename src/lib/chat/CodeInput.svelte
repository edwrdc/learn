<script lang="ts">
	import { tick } from "svelte";
	import { codeKeydown } from "./code-input";

	let { value, onChange, onSubmit, onEscape, onLeave }: {
		value: string;
		onChange: (value: string) => void;
		onSubmit: () => void;
		onEscape?: () => void;
		onLeave?: () => void;
	} = $props();
	let open = $state(false);
	let field = $state<HTMLTextAreaElement | null>(null);

	async function openCode() {
		open = true;
		await tick();
		field?.focus();
	}
</script>

{#if open || value}
	<div class="border-t border-border/60 px-2.5 py-2">
		<label class="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
			Code
			<textarea
				bind:this={field}
				{value}
				data-testid="code-field"
				oninput={(event) => onChange(event.currentTarget.value)}
				onkeydown={(event) => codeKeydown(event, onChange, onSubmit, onEscape, onLeave)}
				spellcheck={false}
				autocapitalize="off"
				autocomplete="off"
				wrap="off"
				rows={4}
				class="lh-input mt-1 max-h-64 min-h-24 w-full resize-y bg-transparent font-mono text-sm font-normal normal-case tracking-normal outline-none"
			></textarea>
		</label>
		<p class="text-xs text-muted-foreground">
			Enter newline · Tab 4 spaces · Shift+Tab thinking level · Esc text · Ctrl/Cmd+Enter submit
		</p>
	</div>
{:else}
	<button type="button" data-testid="add-code" onclick={openCode} class="px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground">Add code</button>
{/if}
