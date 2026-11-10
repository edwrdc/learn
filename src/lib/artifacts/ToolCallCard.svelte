<script lang="ts">
	import { ChevronRight } from "@lucide/svelte";
	import type { ArtifactPartProps } from "@/src/session/model";
	import { toolArg } from "@/src/tools/model";

	let { part }: { part: ArtifactPartProps["part"] } = $props();
	const tool = $derived(part.type.replace(/^tool-/, ""));
	const arg = $derived(toolArg(tool, part.input));
	const errorText = $derived((part as { errorText?: unknown }).errorText);
	const failed = $derived(part.state === "output-error" || typeof errorText === "string");
	const out = $derived.by(() => {
		const output = part.output;
		if (output == null) return null;
		if (typeof output === "string") return output;
		if (typeof output === "object" && "text" in (output as Record<string, unknown>)) {
			const o = output as { text?: unknown; images?: unknown[] };
			const text = typeof o.text === "string" ? o.text : null;
			const n = Array.isArray(o.images) ? o.images.length : 0;
			return n > 0 ? `${text ?? ""}\n[${n} image${n > 1 ? "s" : ""} attached to the model]`.trim() : text;
		}
		try {
			return JSON.stringify(output, null, 2);
		} catch {
			return String(output);
		}
	});
</script>

<details data-testid="tool-call-card" data-tool={tool} class="group my-1 w-full max-w-2xl select-none">
	<summary class="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
		<span class="font-medium uppercase tracking-wide {failed ? 'text-red-500' : ''}">{tool}</span>
		{#if arg}<span class="truncate">{arg}</span>{/if}
		<ChevronRight class="size-3 shrink-0 opacity-50 transition-transform group-open:rotate-90" />
	</summary>
	<div class="mt-2 space-y-2 rounded-xl border bg-card p-3 text-xs">
		{#if part.input != null}
			<div>
				<div class="mb-1 font-medium uppercase tracking-wide text-muted-foreground">Input</div>
				<pre class="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">{JSON.stringify(part.input, null, 2)}</pre>
			</div>
		{/if}
		{#if typeof errorText === "string"}
			<div>
				<div class="mb-1 font-medium uppercase tracking-wide text-muted-foreground">Error</div>
				<pre class="whitespace-pre-wrap break-all font-mono text-[11px] text-red-500">{errorText}</pre>
			</div>
		{:else if out != null}
			<div>
				<div class="mb-1 font-medium uppercase tracking-wide text-muted-foreground">Output</div>
				<pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">{out}</pre>
			</div>
		{:else if part.state !== "output-available"}
			<div class="text-muted-foreground italic">running…</div>
		{/if}
	</div>
</details>
