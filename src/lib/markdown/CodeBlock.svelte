<script lang="ts">
	import { browser } from "$app/environment";
	import CopyCorner from "./CopyCorner.svelte";
	import { lineSpans } from "./copy";
	import { highlightCode } from "./highlight";

	let {
		source,
		lang = "",
		meta = "",
	}: { source: string; lang?: string; meta?: string } = $props();

	const startLine = $derived.by(() => {
		const match = /startLine=(\d+)/.exec(meta);
		return match ? Number.parseInt(match[1]!, 10) : undefined;
	});
	const lineNumbers = $derived(!/\bnoLineNumbers\b/.test(meta));

	/** The highlight of one exact source: a streaming block shows plain
	 *  lines until its current text has been highlighted. */
	let highlighted = $state<{ source: string; lang: string; html: string } | null>(null);

	$effect(() => {
		if (!browser) return;
		const request = { source, lang };
		let cancelled = false;
		void highlightCode(request.source, request.lang).then((html) => {
			if (!cancelled && html) highlighted = { ...request, html };
		});
		return () => {
			cancelled = true;
		};
	});

	const body = $derived(
		highlighted && highlighted.source === source && highlighted.lang === lang ? highlighted.html : lineSpans(source),
	);
</script>

<div class="group/md relative" data-testid="md-code">
	<CopyCorner class="absolute top-1.5 right-2 z-10" label="Copy code" getText={() => source} />
	<div data-streamdown="code-block">
		<pre data-streamdown="code-block-body" class="overflow-x-auto"><code
			class="lh-code-block language-{lang}"
			data-lh-line-numbers={lineNumbers ? "" : undefined}
			style={startLine ? `--lh-start-line: ${startLine - 1}` : undefined}
		>{@html body}</code></pre>
	</div>
</div>
