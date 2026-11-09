<script lang="ts">
	import { dismissLayer } from "$lib/ui/layer";
	import { emitAppEvent, onAppEvent, onKeyAction } from "$lib/events";
	import { listChats } from "$lib/api/chats";
	import { renameSession } from "$lib/state/sessions";
	import { page } from "$app/state";
	import { goto } from "$app/navigation";
	import { onMount } from "svelte";
	import { Dumbbell, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings } from "@lucide/svelte";
	import { fuzzyScore } from "@/src/platform/model";
import { type ChatListItem } from "@/src/session/model";
	import { hint } from "$lib/hint";
	import MenuShell from "$lib/ui/MenuShell.svelte";
	import LhMark from "$lib/ui/LhMark.svelte";
	import ActivitySection from "./ActivitySection.svelte";
	import CoverageMenuBlock from "./CoverageMenuBlock.svelte";
	import DeleteSessionDialog from "./DeleteSessionDialog.svelte";
	import { sidebar } from "$lib/state/sidebar.svelte";
	import { settingsDialog } from "$lib/state/dialogs.svelte";
	import { serverEvents } from "$lib/state/server-events";
	import { cn } from "$lib/utils";
	import SessionRow from "./SessionRow.svelte";
	import { sessionMeta } from "./session-row";

	type KindFilter = "teach" | "all" | "practice";
	const KIND_FILTER_KEY = "lh:session-kind-filter";

	let chats = $state<ChatListItem[] | null>(null);
	let query = $state("");
	let kindFilter = $state<KindFilter>("all");
	let kbdIndex = $state<number | null>(null);
	let renamingId = $state<string | null>(null);
	let renameDraft = $state("");
	let deleting = $state<ChatListItem | null>(null);
	let ctxChat = $state<ChatListItem | null>(null);
	let ctxAnchor = $state<HTMLElement | null>(null);
	let searchRef = $state<HTMLInputElement | null>(null);
	let listRef = $state<HTMLDivElement | null>(null);
	let inFlight = false;
	let debounce: ReturnType<typeof setTimeout> | undefined;

	const open = $derived(sidebar.open);
	const pathname = $derived(page.url.pathname);

	const shown = $derived.by(() => {
		if (chats === null) return null;
		let list = kindFilter === "all" ? chats : chats.filter((c) => (c.kind ?? "teach") === kindFilter);
		const q = query.trim();
		if (!q) return list;
		return list
			.map((c) => ({ c, score: fuzzyScore(q, c.title) }))
			.filter((r): r is { c: ChatListItem; score: number } => r.score !== null)
			.sort((a, b) => b.score - a.score)
			.map((r) => r.c);
	});


	async function refresh() {
		if (inFlight) return;
		inFlight = true;
		try {
			chats = await listChats();
		} catch (error) {
			console.error("[sidebar] session list load failed:", error);
			chats = chats ?? [];
		} finally {
			inFlight = false;
		}
	}

	function scheduleRefresh() {
		clearTimeout(debounce);
		debounce = setTimeout(() => void refresh(), 250);
	}

	function patch(id: string, patch: Partial<ChatListItem>) {
		chats = chats ? chats.map((c) => (c.id === id ? { ...c, ...patch } : c)) : chats;
	}

	async function commitRename(id: string, next: string) {
		renamingId = null;
		const title = next.trim();
		if (title === "") return;
		try {
			await renameSession(id, title);
		} catch (error) {
			console.error("[sidebar] rename failed:", error);
		}
	}

	function openSession(id: string) {
		kbdIndex = null;
		void goto(`/chat/${encodeURIComponent(id)}`);
	}

	function onDeleted(id: string, graphRevision: number) {
		deleting = null;
		chats = chats ? chats.filter((c) => c.id !== id) : chats;
		if (pathname === `/chat/${id}`) void goto("/");
		emitAppEvent("graph-revision", { graphRevision });
	}

	function openContext(event: MouseEvent, chat: ChatListItem) {
		event.preventDefault();
		ctxAnchor = event.currentTarget as HTMLElement;
		ctxChat = chat;
	}

	$effect(() => {
		// Refetch on open and on navigation (the events channel owns freshness while open).
		if (!open) return;
		void pathname;
		void refresh();
	});

	$effect(() => {
		if (kbdIndex === null || !listRef) return;
		listRef.querySelectorAll("button")[kbdIndex]?.scrollIntoView({ block: "nearest" });
	});

	$effect(() => {
		if (typeof window === "undefined") return;
		const stored = window.localStorage.getItem(KIND_FILTER_KEY);
		if (stored === "teach" || stored === "all" || stored === "practice") kindFilter = stored;
	});

	onMount(() => {
		const offs = [
			serverEvents.subscribe("chats-changed", scheduleRefresh),
			serverEvents.subscribe("turn-started", scheduleRefresh),
			serverEvents.subscribe("turn-settled", scheduleRefresh),
			serverEvents.subscribe("compaction-changed", scheduleRefresh),
			serverEvents.onResync(() => void refresh()),
		];
		const onRenamed = ({ id, title }: { id: string; title: string }) => patch(id, { title });
		const onTurnState = ({ id, running }: { id: string; running: boolean }) => {
			if (running) {
				if (chats?.some((c) => c.id === id)) patch(id, { busy: true });
				else void refresh();
				return;
			}
			patch(id, { busy: false });
			void refresh();
		};
		const onSearch = () => {
			if (!open) sidebar.toggle();
			requestAnimationFrame(() => searchRef?.focus());
		};
		offs.push(onAppEvent("chat-renamed", onRenamed), onAppEvent("turn-state", onTurnState), onKeyAction("sessions-search", onSearch));
		void refresh();
		return () => {
			for (const off of offs) off();
			clearTimeout(debounce);
		};
	});

	$effect(() => {
		if (ctxChat === null) return;
		return dismissLayer(() => (ctxChat = null), { inside: () => [ctxAnchor], menus: true });
	});

	function setFilter(filter: KindFilter) {
		kindFilter = filter;
		window.localStorage.setItem(KIND_FILTER_KEY, filter);
	}

	function onSearchKey(event: KeyboardEvent) {
		if (event.key === "Escape") {
			event.stopPropagation();
			(event.currentTarget as HTMLInputElement).blur();
			return;
		}
		if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
		const list = shown ?? [];
		if (list.length === 0) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const dir = event.key === "ArrowDown" ? 1 : -1;
			kbdIndex =
				kbdIndex === null || kbdIndex >= list.length
					? dir === 1
						? 0
						: list.length - 1
					: (kbdIndex + dir + list.length) % list.length;
			return;
		}
		if (event.key === "Enter") {
			const target = list[kbdIndex !== null && kbdIndex < list.length ? kbdIndex : 0];
			if (!target) return;
			event.preventDefault();
			openSession(target.id);
			(event.currentTarget as HTMLInputElement).blur();
		}
	}
</script>

<aside
	class={cn("sidebar-motion shrink-0 overflow-hidden duration-200", open ? "w-72" : "w-0")}
	aria-hidden={!open}
>
	<div class="flex h-full w-72 flex-col border-r bg-background">
		<div class="lh-drag lh-lights-gutter flex items-center justify-between px-4 py-3">
			<a
				href="/"
				aria-label="Home"
				{@attach hint("Home", { action: "jump-graph", side: "right" })}
				onclick={(event) => {
					event.preventDefault();
					void goto("/");
				}}
				class="lh-no-drag flex size-9 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-accent-foreground"
			>
				<LhMark class="size-6" />
			</a>
			<button
				type="button"
				aria-label="Close sidebar"
				{@attach hint("Close sidebar", { action: "toggle-sidebar" })}
				onclick={() => sidebar.toggle()}
				class="lh-no-drag inline-flex size-9 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-accent-foreground"
			>
				<PanelLeftClose class="size-4" />
			</button>
		</div>

		<div class="mx-3 mb-2 flex flex-col gap-1.5">
			<button
				type="button"
				data-testid="new-session"
				onclick={() => void goto("/chat/new")}
				class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<Plus class="size-3" />
				Teaching
				<span class="sr-only">create a new teaching session</span>
			</button>
			<button
				type="button"
				data-testid="new-session-practice"
				onclick={() => void goto("/chat/new?mode=practice")}
				class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<Dumbbell class="size-3" />
				Practice
				<span class="sr-only">create a new practice session</span>
			</button>
		</div>

		<div class="mx-3 mb-2 flex items-center gap-2">
			<span class="text-xs uppercase tracking-widest text-muted-foreground/70">Sessions</span>
			<span class="relative flex-1">
				<input
					bind:this={searchRef}
					data-testid="session-search"
					value={query}
					oninput={(event) => {
						query = (event.currentTarget as HTMLInputElement).value;
						kbdIndex = null;
					}}
					onkeydown={onSearchKey}
					placeholder="Search…"
					aria-label="Search sessions"
					{@attach hint("Search sessions", { action: "sessions-search", side: "bottom" })}
					class="lh-input h-6 w-full rounded-sm border border-border bg-background pl-6 text-xs placeholder:text-muted-foreground/60"
				/>
				<Search class="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/70" />
			</span>
		</div>

		<div class="mx-3 flex items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5" data-testid="session-kind-filter">
			{#each [["teach", "Teaching"], ["practice", "Practice"], ["all", "All"]] as [value, label] (value)}
				<button
					type="button"
					data-testid={`kind-filter-${value}`}
					onclick={() => setFilter(value as KindFilter)}
					class={cn(
						"flex-1 rounded-sm px-2 py-1 text-[11px] uppercase tracking-wider transition-colors",
						kindFilter === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
					)}
				>
					{label}
				</button>
			{/each}
		</div>

		<div bind:this={listRef} class="flex-1 overflow-y-auto p-2">
			{#if shown === null}
				<div class="px-2 py-4 text-xs text-muted-foreground">Loading…</div>
			{:else if shown.length === 0}
				<div class="px-2 py-4 text-xs text-muted-foreground">
					{query.trim() ? "No sessions match." : "No sessions yet."}
				</div>
			{:else}
				{#each shown as chat, i (chat.id)}
					{#if renamingId === chat.id}
						<div data-testid="session-rename-row" class="relative mb-0.5 flex w-full items-center rounded-lg bg-accent px-3 py-2">
							<span class="flex min-w-0 w-full flex-col">
								<input
									value={renameDraft}
									spellcheck={false}
									oninput={(event) => (renameDraft = (event.currentTarget as HTMLInputElement).value)}
									onblur={() => void commitRename(chat.id, renameDraft)}
									onkeydown={(event) => {
										if (event.key === "Enter") (event.currentTarget as HTMLInputElement).blur();
										if (event.key === "Escape") {
											event.stopPropagation();
											renamingId = null;
										}
									}}
									aria-label="Rename session"
									data-testid="session-rename-input"
									class="lh-input w-full min-w-0 truncate border-0 border-b border-border bg-transparent px-0 text-foreground outline-none"
								/>
								<span class="block truncate text-xs text-muted-foreground">{sessionMeta(chat)}</span>
							</span>
						</div>
						{:else}
						<SessionRow
							{chat}
							active={pathname === `/chat/${chat.id}`}
							keyboardFocused={i === kbdIndex && pathname !== `/chat/${chat.id}`}
							onOpen={() => openSession(chat.id)}
							onContextMenu={(event) => openContext(event, chat)}
						/>
					{/if}
				{/each}
			{/if}
		</div>

		<ActivitySection />

		<div class="px-3 pb-3 pt-1">
			<button
				type="button"
				onclick={() => settingsDialog.open()}
				data-testid="settings-entry"
				{@attach hint("Settings", { action: "open-settings", side: "right" })}
				class="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<Settings class="size-3" />
				Settings
			</button>
		</div>
	</div>

	{#if ctxChat}
		<MenuShell
			anchor={ctxAnchor}
			testid="session-context-menu"
			preferredSide="down"
			menuClass="flex w-52 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
		>
			<button
				type="button"
				data-testid="ctx-rename"
				onclick={() => {
					if (ctxChat) {
						renamingId = ctxChat.id;
						renameDraft = ctxChat.title;
					}
					ctxChat = null;
				}}
				class="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
			>
				Rename
			</button>
			<button
				type="button"
				data-testid="ctx-export-md"
				onclick={() => {
					const id = ctxChat?.id;
					ctxChat = null;
					if (!id) return;
					const anchor = document.createElement("a");
					anchor.href = `/api/chats/${id}/markdown`;
					anchor.download = "";
					document.body.appendChild(anchor);
					anchor.click();
					anchor.remove();
				}}
				class="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
			>
				Export as Markdown…
			</button>
			<button
				type="button"
				data-testid="ctx-delete"
				onclick={() => {
					deleting = ctxChat;
					ctxChat = null;
				}}
				class="flex items-center rounded-lg px-2.5 py-1.5 text-left text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
			>
				Delete…
			</button>
			<div class="my-0.5 border-t border-border/60" aria-hidden="true"></div>
			{#if ctxChat}
				<CoverageMenuBlock chatId={ctxChat.id} />
			{/if}
		</MenuShell>
	{/if}

	<DeleteSessionDialog chat={deleting} onClose={() => (deleting = null)} {onDeleted} />
</aside>
