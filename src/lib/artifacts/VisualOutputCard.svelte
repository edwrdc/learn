<script lang="ts">
import { untrack } from "svelte";
	import { getContext } from "svelte";
	import { Download, Maximize } from "@lucide/svelte";
	import type { VisualResult } from "@/src/core";
	import { CHAT_ACTIONS, type ChatActions } from "$lib/chat/actions-context";
	import { SESSION_MERMAID } from "$lib/chat/session-context";
	import type { SessionMermaidApi } from "$lib/chat/types";
	import Toggle from "$lib/ui/Toggle.svelte";
	import { downloadFile } from "./download";
	import InvertDisc from "./InvertDisc.svelte";
	import SvgImage from "./SvgImage.svelte";

	let {
		output,
		messageId,
		initialInverted = false,
	}: { output: unknown; messageId?: string; initialInverted?: boolean } = $props();

	const actions = getContext<ChatActions | null>(CHAT_ACTIONS) ?? null;
	const overlay = getContext<SessionMermaidApi | null>(SESSION_MERMAID) ?? null;
	const result = $derived(output as VisualResult | undefined);
	let inverted = $state(untrack(() => initialInverted));

	const natural = $derived.by(() => {
		if (!result || typeof result.svg !== "string") return null;
		const match = /<svg\b[^>]*?\bwidth\s*=\s*["']([^"']+)["'][^>]*>/i.exec(result.svg);
		if (!match) return null;
		const px = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(match[1]!.trim());
		if (!px) return null;
		const n = Number.parseFloat(px[1]!);
		return Number.isFinite(n) && n > 0 ? n : null;
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

{#if !result || typeof result.svg !== "string"}
	<div class="rounded-xl border bg-card p-4 text-sm text-muted-foreground">Figure completed, but the result could not be displayed.</div>
{:else if result.svg.length === 0}
	<div class="rounded-xl border bg-card p-4 text-card-foreground" data-testid="visual-card-failed">
		<div class="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
			Figure <span class="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>
		</div>
		<p class="mt-2 text-sm text-muted-foreground">{result.notes ?? "The figure could not be drawn."}</p>
	</div>
{:else}
	<div class={natural !== null ? "my-4 mx-auto w-fit max-w-full" : "my-4 w-full"} data-testid="visual-card">
		<div
			class={natural !== null ? "w-fit max-w-full overflow-hidden rounded-lg bg-white" : "w-full overflow-hidden rounded-lg bg-white"}
			style={inverted ? "filter: invert(1) hue-rotate(180deg)" : undefined}
			data-testid="visual-svg"
		>
			<SvgImage svg={result.svg} width={natural ?? undefined} class={natural !== null ? "block h-auto max-w-full" : "block h-auto w-full"} />
		</div>
		<div class="mt-2 flex items-center justify-between gap-2">
			<div class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Figure</div>
			<div class="flex items-center gap-1.5">
				<Toggle checked={inverted} onChange={toggleInverted} label="Invert figure brightness" title="Invert colors">
					{#snippet disc()}<InvertDisc class="size-3" />{/snippet}
				</Toggle>
				<button type="button" aria-label="Download figure as SVG" title="Download as SVG" onclick={() => downloadFile("figure.svg", result.svg, "image/svg+xml")} data-testid="visual-download" class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
					<Download class="size-3.5" />
				</button>
				{#if overlay}
					<button type="button" aria-label="Open figure fullscreen" title="Open fullscreen" onclick={() => overlay.openFigure(result.svg, inverted)} data-testid="visual-open" class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
						<Maximize class="size-3.5" />
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}
