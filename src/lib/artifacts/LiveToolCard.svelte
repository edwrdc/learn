<script lang="ts">
	import { ChevronRight } from "@lucide/svelte";
	import { toolActivityLabel } from "@/src/tools/model";
	import BrailleSpinner from "$lib/ui/BrailleSpinner.svelte";

	let { part }: { part: { type: string; state: string; toolCallId: string; input?: unknown } } = $props();
	const tool = $derived(part.type.replace(/^tool-/, ""));
	const input = $derived((part.input ?? {}) as Record<string, unknown>);
	const arg = $derived(
		typeof input.path === "string" && input.path
			? input.path
			: typeof input.pattern === "string" && input.pattern
				? input.pattern
				: typeof input.session === "string" && input.session
					? input.session
					: "",
	);
	const hasInput = $derived(part.input != null && Object.keys(input).length > 0);
</script>

<details data-testid="live-tool-card" data-tool={tool} class="group my-1 w-full max-w-2xl select-none">
	<summary class="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
		<BrailleSpinner label={`${toolActivityLabel(tool)} — live`} />
		<span class="animate-pulse text-xs">{toolActivityLabel(tool)}</span>
		{#if arg}<span class="truncate">{arg}</span>{/if}
		<ChevronRight class="size-3 shrink-0 opacity-50 transition-transform group-open:rotate-90" />
	</summary>
	<div class="mt-2 rounded-xl border bg-card p-3 text-xs">
		<div class="mb-1 font-medium uppercase tracking-wide text-muted-foreground">Input (streaming)</div>
		<pre class="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">{hasInput ? JSON.stringify(part.input, null, 2) : "…"}</pre>
	</div>
</details>
