<script lang="ts">
	import { Dumbbell } from "@lucide/svelte";
	import type { ChatListItem } from "@/src/session/model";
	import { cn } from "$lib/utils";
	import BrailleSpinner from "$lib/ui/BrailleSpinner.svelte";
	import { sessionMeta } from "./session-row";

	let {
		chat,
		active = false,
		keyboardFocused = false,
		onOpen,
		onContextMenu,
	}: {
		chat: ChatListItem;
		active?: boolean;
		keyboardFocused?: boolean;
		onOpen: () => void;
		onContextMenu?: (event: MouseEvent) => void;
	} = $props();
</script>

<button
	type="button"
	onclick={onOpen}
	oncontextmenu={onContextMenu}
	data-testid={keyboardFocused ? "session-row-kbd" : "session-row"}
	class={cn(
		"relative mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent",
		active && "bg-accent",
		keyboardFocused && !active && "bg-accent/60 ring-1 ring-border",
	)}
>
	{#if chat.busy || chat.compacting}
		<BrailleSpinner label="Working" />
	{/if}
	<span class="min-w-0 flex-1">
		<span class="block truncate font-prose text-(length:--lh-prose-size)">{chat.title}</span>
		<span class="block text-xs text-muted-foreground">{sessionMeta(chat)}</span>
	</span>
	{#if (chat.kind ?? "teach") === "practice"}
		<Dumbbell class="size-3.5 shrink-0 text-muted-foreground/70" aria-label="Practice session" />
	{/if}
</button>
