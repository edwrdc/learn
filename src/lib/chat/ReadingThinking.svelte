<script lang="ts">
import { untrack } from "svelte";
	import { joinDictation, setDictationTarget } from "./dictation.svelte";

	let {
		value,
		onChange,
		onOpen,
		claim,
	}: {
		value: string;
		onChange: (v: string) => void;
		onOpen?: () => void;
		claim: boolean;
	} = $props();

	let mirror = $state(untrack(() => value));
	$effect(() => {
		mirror = value;
	});

	$effect(() => {
		if (!claim) return;
		setDictationTarget((text) => {
			const next = joinDictation(mirror, text);
			mirror = next;
			onChange(next);
		});
		return () => setDictationTarget(null);
	});
</script>

<div
	data-testid="reading-thinking-field"
	class="pointer-events-auto mb-2 rounded-2xl border bg-card/60 px-3 py-2 transition-colors focus-within:border-primary/50"
>
	<div class="pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Thinking while reading</div>
	<textarea
		value={mirror}
		oninput={(event) => {
			mirror = (event.currentTarget as HTMLTextAreaElement).value;
			onChange(mirror);
		}}
		onkeydown={(event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			if (event.key === "Enter" && onOpen !== undefined && (!event.shiftKey || event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				event.stopPropagation();
				onOpen();
				return;
			}
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				(event.currentTarget as HTMLTextAreaElement).blur();
			}
		}}
		placeholder="Whatever comes to mind as you read."
		rows={1}
		class="field-sizing-content lh-input max-h-40 w-full resize-none bg-transparent py-0.5 outline-none placeholder:text-muted-foreground/70"
	></textarea>
</div>
