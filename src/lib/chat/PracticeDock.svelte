<script lang="ts">
	import { ChevronRight } from "@lucide/svelte";
	import Markdown from "$lib/markdown/Markdown.svelte";
	import { enterSubmits } from "$lib/ui/enter-submits";
	import CodeInput from "./CodeInput.svelte";
	import { withCode } from "./code-input";
	import { afterDictation, joinDictation, setDictationTarget } from "./dictation.svelte";

	let {
		problemCallId,
		input,
		expanded,
		onExpand,
		onSubmit,
		compactionRunning = false,
	}: {
		problemCallId: string;
		input: { statement: string };
		expanded: boolean;
		onExpand: () => void;
		onSubmit: (text: string) => void;
		compactionRunning?: boolean;
	} = $props();

	let thinking = $state("");
	let code = $state("");
	let prose = $state<HTMLTextAreaElement | null>(null);
	let mirror = "";

	$effect(() => {
		setDictationTarget((text) => {
			const next = joinDictation(mirror, text);
			mirror = next;
			thinking = next;
		});
		return () => setDictationTarget(null);
	});

	function doSubmit() {
		if (compactionRunning) return;
		const text = withCode(mirror, code).trim();
		if (text.length === 0) return;
		mirror = "";
		thinking = "";
		code = "";
		onSubmit(text);
	}
	function submit() {
		afterDictation(doSubmit);
	}
</script>

{#if !expanded}
	<button
		type="button"
		data-testid="practice-dock-bar"
		onclick={onExpand}
		class="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
	>
		<ChevronRight class="size-4 shrink-0 rotate-90" />
		<span class="font-medium">Problem</span>
		<span class="min-w-0 flex-1 truncate">{input.statement}</span>
	</button>
{:else}
	<div data-testid="practice-dock" data-problem={problemCallId} {@attach enterSubmits(submit)}>
		<div class="max-h-[var(--dock-max-h,40vh)] overflow-y-auto px-4 pt-3 pb-2">
			<div class="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Problem</div>
			<div class="lh-prose text-[15px]"><Markdown text={input.statement} tool /></div>
		</div>
		<div
			data-testid="practice-thinking-field"
			class="m-1.5 rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50"
		>
			<div class="px-2.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">YOUR THINKING</div>
			<textarea
				bind:this={prose}
				data-testid="prose-field"
				value={thinking}
				oninput={(event) => {
					mirror = (event.currentTarget as HTMLTextAreaElement).value;
					thinking = mirror;
				}}
				onkeydown={(event) => {
					if (event.key === "Enter" && (!event.shiftKey || event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						submit();
					}
				}}
				placeholder="Work here, think out loud."
				rows={4}
				class="field-sizing-content lh-input max-h-64 min-h-16 w-full resize-none bg-transparent px-2.5 pb-2 outline-none placeholder:text-muted-foreground"
			></textarea>
			<CodeInput value={code} onChange={(value) => (code = value)} onSubmit={submit} onLeave={() => prose?.focus()} />
			<div class="flex items-center justify-between gap-2 p-1">
				<span aria-hidden="true" class="pl-1.5 text-xs text-muted-foreground">
					{compactionRunning ? "compacting session…" : "↵ submits · ⇧↵ newline"}
				</span>
				<button
					type="button"
					data-testid="practice-send"
					disabled={(!thinking.trim() && !code.trim()) || compactionRunning}
					onclick={() => submit()}
					class="ml-auto h-9 rounded-[6px] bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-40"
				>
					Submit thinking
				</button>
			</div>
		</div>
	</div>
{/if}
