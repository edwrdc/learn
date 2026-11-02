<script lang="ts">
import { untrack } from "svelte";
	import { getContext } from "svelte";
	import { Download } from "@lucide/svelte";
	import type { DemoResult } from "@/src/core";
	import { CHAT_ACTIONS, type ChatActions } from "$lib/chat/actions-context";
	import Toggle from "$lib/ui/Toggle.svelte";
	import { buildDemoSrcDoc, INITIAL_DEMO_BRIDGE_STATE, reduceDemoBridgeState, type DemoBridgeState } from "./demo-bridge";
	import { downloadFile, slugFilename } from "./download";
	import InvertDisc from "./InvertDisc.svelte";

	let {
		output,
		messageId,
		initialInverted = false,
	}: { output: unknown; messageId?: string; initialInverted?: boolean } = $props();

	const actions = getContext<ChatActions | null>(CHAT_ACTIONS) ?? null;
	const result = $derived(output as DemoResult | undefined);
	let inverted = $state(untrack(() => initialInverted));
	let bridge = $state<DemoBridgeState>(INITIAL_DEMO_BRIDGE_STATE);
	let frame = $state<HTMLIFrameElement | null>(null);

	const srcDoc = $derived(result ? buildDemoSrcDoc(result.html) : "");

	$effect(() => {
		if (typeof window === "undefined") return;
		const onMessage = (event: MessageEvent) => {
			if (!frame || event.source !== frame.contentWindow) return;
			bridge = reduceDemoBridgeState(bridge, event.data);
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	});

	function toggleInverted(next: boolean) {
		inverted = next;
		if (!actions?.chatId || !messageId) return;
		void fetch(`/api/chats/${actions.chatId}/artifact-ui`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { messageId, inverted: next } }),
		}).catch(() => {});
	}
</script>

{#if !result || typeof result.html !== "string" || typeof result.title !== "string"}
	<div class="rounded-xl border bg-card p-4 text-sm text-muted-foreground">Demo completed, but the result could not be displayed.</div>
{:else if result.html.length === 0}
	<div class="rounded-xl border bg-card p-4 text-card-foreground" data-testid="demo-card-failed">
		<div class="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
			Interactive demo <span class="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>
		</div>
		<p class="mt-2 text-sm text-muted-foreground">{result.notes ?? "The demo could not be built."}</p>
	</div>
{:else}
	<div class="rounded-xl border bg-card p-4 text-card-foreground" data-testid="demo-card">
		<div class="flex items-center justify-between gap-2">
			<div class="flex min-w-0 items-baseline gap-2">
				<span class="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">interactive demo</span>
				<span class="truncate text-xs font-medium tracking-wide text-foreground">{result.title}</span>
			</div>
			<div class="flex shrink-0 items-center gap-1.5">
				<Toggle checked={inverted} onChange={toggleInverted} label="Invert demo brightness" title="Invert colors">
					{#snippet disc()}<InvertDisc class="size-3" />{/snippet}
				</Toggle>
				<button type="button" aria-label="Download demo as HTML" title="Download as HTML" onclick={() => downloadFile(`${slugFilename(result.title)}.html`, result.html, "text/html")} data-testid="demo-download" class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
					<Download class="size-3.5" />
				</button>
			</div>
		</div>
		{#if bridge.error}
			<div class="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500" data-testid="demo-error-chip">
				<span class="font-medium">This demo threw an error</span>
				<span class="min-w-0 flex-1 truncate font-mono text-xs" title={bridge.error}>{bridge.error}</span>
				{#if actions}
					<button type="button" onclick={() => actions.sendText(`The demo "${result.title}" threw an error: ${bridge.error}`)} class="rounded-md border border-red-500/40 px-2 py-1 text-xs font-medium hover:bg-red-500/15" data-testid="demo-error-send">Send to teacher</button>
				{/if}
			</div>
		{/if}
		<iframe
			bind:this={frame}
			title={result.title}
			sandbox="allow-scripts"
			srcdoc={srcDoc}
			scrolling="no"
			class="mt-2 w-full rounded-lg border bg-white"
			style="height: {bridge.height ?? 360}px; box-sizing: content-box;{inverted ? ' filter: invert(1) hue-rotate(180deg);' : ''}"
			data-testid="demo-iframe"
		></iframe>
	</div>
{/if}
