<script lang="ts">
	import { ChevronDown, ChevronUp, Search, X } from "@lucide/svelte";
	import { kbdEventForAction } from "@/src/settings/model";
import { stepSessionMatch } from "@/src/session/model";
	import {
		sameSessionRange,
		sessionFindRanges,
		sessionRangeIdentity,
		type SessionRangeIdentity,
	} from "$lib/chat/session-find-dom.ts";
	import {
		clearSessionFindHighlights,
		injectFindStyles,
		sessionFindHasForegroundLayer,
		SESSION_FIND_ACTIVE_HIGHLIGHT as ACTIVE,
		SESSION_FIND_HIGHLIGHT as HIGHLIGHT,
	} from "$lib/chat/session-find.ts";

	let {
		scope,
		scrollTo,
	}: {
		scope: HTMLElement | null;
		scrollTo: (range: Range) => void;
	} = $props();

	let open = $state(false);
	let query = $state("");
	let index = $state(-1);
	let count = $state(0);
	let input = $state<HTMLInputElement | null>(null);
	let previousFocus: HTMLElement | null = null;
	let ranges: Range[] = [];
	let identity: SessionRangeIdentity | null = null;
	let lastQuery: string | null = null;


	function publish() {
		if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
		const all = new Highlight();
		for (const range of ranges) all.add(range);
		CSS.highlights.set(HIGHLIGHT, all);
		const active = new Highlight();
		active.priority = 1;
		if (ranges[index]) active.add(ranges[index]!);
		CSS.highlights.set(ACTIVE, active);
	}


	function close() {
		clearSessionFindHighlights();
		open = false;
		if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
	}

	function refresh(selectFirst: boolean) {
		if (!scope) return;
		ranges = sessionFindRanges(scope, query);
		let next = selectFirst ? 0 : ranges.findIndex((range) => sameSessionRange(range, identity));
		if (next < 0) next = Math.max(0, Math.min(index, ranges.length - 1));
		if (ranges.length === 0) next = -1;
		index = next;
		count = ranges.length;
		identity = ranges[next] ? sessionRangeIdentity(ranges[next]!) : null;
		publish();
		if (selectFirst && ranges[next]) scrollTo(ranges[next]!);
	}

	function step(direction: 1 | -1) {
		if (ranges.length === 0) return;
		index = stepSessionMatch(index, ranges.length, direction);
		identity = ranges[index] ? sessionRangeIdentity(ranges[index]!) : null;
		publish();
		if (ranges[index]) scrollTo(ranges[index]!);
	}

	$effect(() => {
		injectFindStyles();
		const onFind = () => {
			if (sessionFindHasForegroundLayer(document)) return;
			if (!open) previousFocus = document.activeElement as HTMLElement | null;
			open = true;
			requestAnimationFrame(() => {
				input?.focus({ preventScroll: true });
				input?.select();
			});
		};
		window.addEventListener(kbdEventForAction("find"), onFind);
		return () => window.removeEventListener(kbdEventForAction("find"), onFind);
	});

	$effect(() => {
		if (!open) return;
		const onEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || sessionFindHasForegroundLayer(document)) return;
			event.preventDefault();
			event.stopPropagation();
			close();
		};
		document.addEventListener("keydown", onEscape);
		return () => document.removeEventListener("keydown", onEscape);
	});

	$effect(() => {
		if (!open || !scope) return;
		let frame: number | null = null;
		refresh(lastQuery !== query);
		lastQuery = query;
		const schedule = () => {
			if (frame !== null) return;
			frame = requestAnimationFrame(() => {
				frame = null;
				refresh(false);
			});
		};
		const observer = new MutationObserver(schedule);
		observer.observe(scope, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true,
			attributeFilter: ["hidden", "style", "class", "data-state", "aria-expanded"],
		});
		window.addEventListener("resize", schedule);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", schedule);
			if (frame !== null) cancelAnimationFrame(frame);
			clearSessionFindHighlights();
		};
	});

	const buttonClass = "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40";
</script>

{#if open}
	<div
		role="search"
		aria-label="Session Find"
		data-testid="session-find"
		class="lh-no-drag flex h-10 shrink-0 items-center gap-2 border-b border-border px-6 font-ui text-sm"
	>
		<Search class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		<input
			bind:this={input}
			aria-label="Find in session"
			placeholder="Find in session…"
			value={query}
			oninput={(event) => (query = (event.currentTarget as HTMLInputElement).value)}
			spellcheck={false}
			class="lh-input min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
		/>
		<output aria-live="polite" data-testid="session-find-count" class="shrink-0 text-xs tabular-nums text-muted-foreground">
			{query ? `${index + 1}/${count}` : ""}
		</output>
		<button type="button" aria-label="Previous match" title="Previous match (Shift+Enter)" class={buttonClass} disabled={!count} onmousedown={(event) => event.preventDefault()} onclick={() => step(-1)}>
			<ChevronUp class="size-4" aria-hidden="true" />
		</button>
		<button type="button" aria-label="Next match" title="Next match (Enter)" class={buttonClass} disabled={!count} onmousedown={(event) => event.preventDefault()} onclick={() => step(1)}>
			<ChevronDown class="size-4" aria-hidden="true" />
		</button>
		<button type="button" aria-label="Close Find" title="Close Find (Esc)" class={buttonClass} onclick={close}>
			<X class="size-4" aria-hidden="true" />
		</button>
	</div>
{/if}
