<script lang="ts">
import { untrack } from "svelte";
	import { tick, type Snippet } from "svelte";
	import { ArrowDown } from "@lucide/svelte";
	import type { Phase3, TurnUsage } from "@/src/core";
	import { dockStateKey } from "$lib/chat/dock-state-key.ts";
	import type { SteerQueueItem } from "$lib/chat/session-core.ts";
	import QueuedSteers from "./QueuedSteers.svelte";
	import ReadingThinking from "./ReadingThinking.svelte";
	import QuestionDock from "./QuestionDock.svelte";
	import PracticeDock from "./PracticeDock.svelte";
	import StatsBar from "./StatsBar.svelte";
	import type { StickToBottom } from "./stick.svelte";
	import type { QuestionAnswerData } from "@/src/core";

	type Pending = { tool: string; toolCallId: string; input: unknown } | null;
	type Practice = { toolCallId: string; input: unknown } | null;

	let {
		pending,
		practice,
		compactionRunning,
		requiresReveal,
		readingThinking,
		phase,
		turns,
		chatId,
		composer,
		onSubmitAnswer,
		onSubmitThinking,
		dictationSlot,
		dictationCancel,
		setupCta,
		queuedSteers,
		plan,
		onOpenPlan,
		stick,
		onReserve,
		onReadingThinking,
	}: {
		pending: Pending;
		practice: Practice;
		compactionRunning: boolean;
		requiresReveal: boolean;
		readingThinking: string;
		onReadingThinking: (value: string) => void;
		phase: Phase3;
		turns: TurnUsage[];
		chatId: string;
		composer: Snippet;
		onSubmitAnswer: (output: QuestionAnswerData) => void;
		onSubmitThinking: (text: string) => void;
		dictationSlot?: Snippet;
		dictationCancel?: () => void;
		setupCta?: Snippet;
		queuedSteers: SteerQueueItem[];
		plan?: Snippet;
		onOpenPlan: () => void;
		stick: StickToBottom;
		onReserve: (height: number) => void;
	} = $props();

	const DOCK_W = 46 * 16;
	const MARGIN_GAP = 16;
	const MARGIN_MIN_W = 220;
	const GRADIENT_H = 96;
	const COLLAPSE_DIST = 96;
	const EXPAND_DIST = 16;

	let block = $state<HTMLDivElement | null>(null);
	let shell = $state<HTMLDivElement | null>(null);
	let content = $state<HTMLDivElement | null>(null);
	let expanded = $state(untrack(() => !requiresReveal));
	let revealed = $state(false);
	let flankW = $state(0);
	let sbInset = $state(0);
	let dockMaxH = $state<number | null>(null);
	let prevPendingId: string | null = untrack(() => pending?.toolCallId ?? null);
	let initialPending = untrack(() => pending?.toolCallId ?? null);
	let prevExpanded = untrack(() => expanded);
	let intent = false;
	let intentTimer: ReturnType<typeof setTimeout> | undefined;
	let geometryAt = 0;
	let growthAt = 0;
	let reserve = 0;
	let prevMorph: { key: string; height: number } | null = null;

	const docked = $derived(!!pending || !!practice);
	const mode = $derived(pending ? `question:${pending.toolCallId}` : practice ? `practice:${practice.toolCallId}` : "chat");
	const stateKey = $derived(dockStateKey(mode, docked, expanded));
	const revealPending = $derived(requiresReveal && !revealed);

	function offer(blockH: number) {
		const next = blockH + GRADIENT_H;
		if (next <= reserve + 0.5 && docked) return;
		if (docked && next > reserve + 1) geometryAt = Date.now();
		reserve = next;
		onReserve(next);
	}

	function measureBlock() {
		if (block) offer(block.getBoundingClientRect().height);
	}

	function suppressFold() {
		intent = true;
		clearTimeout(intentTimer);
		intentTimer = setTimeout(() => (intent = false), 2000);
		stick.scrollToBottom("smooth");
	}

	function expandAndReveal() {
		revealed = true;
		expanded = true;
		suppressFold();
	}

	$effect(() => {
		const id = pending?.toolCallId ?? null;
		if (id === prevPendingId) return;
		const wasQuestion = prevPendingId !== null;
		prevPendingId = id;
		if (id && requiresReveal) {
			expanded = wasQuestion;
			revealed = wasQuestion;
		} else if (id) {
			expanded = stick.isAtBottom;
		}
	});

	$effect(() => {
		if (!shell) return;
		stateKey;
		void tick().then(() => {
			if (!shell) return;
			const el = shell;
			if (prevMorph && prevMorph.key === stateKey) {
				if (el.getAnimations().length === 0) {
					prevMorph.height = el.getBoundingClientRect().height;
					measureBlock();
				}
				return;
			}
			el.getAnimations().forEach((animation) => animation.cancel());
			const height = el.getBoundingClientRect().height;
			measureBlock();
			if (prevMorph && Math.abs(prevMorph.height - height) > 1) {
				el.animate([{ height: `${prevMorph.height}px` }, { height: `${height}px` }], {
					duration: 120,
					easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
				});
			}
			prevMorph = { key: stateKey, height };
		});
	});

	$effect(() => {
		if (prevExpanded === expanded) return;
		prevExpanded = expanded;
		content?.animate(
			[
				{ opacity: 0, transform: "translateY(6px)" },
				{ opacity: 1, transform: "translateY(0)" },
			],
			{ duration: 160, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
		);
	});

	$effect(() => {
		const el = stick.scroller;
		if (!el) return;
		const measure = () => {
			sbInset = Math.round((el.offsetWidth - el.clientWidth) / 2);
			dockMaxH = Math.max(el.clientHeight - 32, 160);
		};
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	});

	$effect(() => {
		const el = stick.scroller;
		const holder = stick.content;
		if (!el || !holder || typeof ResizeObserver === "undefined") return;
		let previous = holder.getBoundingClientRect().height;
		const ro = new ResizeObserver(() => {
			const height = holder.getBoundingClientRect().height;
			if (height > previous + 0.5) growthAt = Date.now();
			previous = Math.max(previous, height);
		});
		ro.observe(holder);
		return () => ro.disconnect();
	});

	$effect(() => {
		if (!block) return;
		const measure = () => {
			const next = Math.round(block!.offsetWidth / 2 - DOCK_W / 2 - 2 * MARGIN_GAP);
			if (Math.abs(next - flankW) > 1) {
				flankW = next;
				geometryAt = Date.now();
			}
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(block);
		return () => ro.disconnect();
	});

	$effect(() => {
		const root = block;
		const el = stick.scroller;
		if (!root || !el) return;
		const canScroll = (node: HTMLElement, dir: number) => {
			if (node.scrollHeight - node.clientHeight < 2) return false;
			return dir < 0 ? node.scrollTop > 0 : node.scrollTop < node.scrollHeight - node.clientHeight - 0.5;
		};
		const onWheel = (event: WheelEvent) => {
			if (event.deltaY === 0) return;
			for (let node = event.target as HTMLElement | null; node && node !== root; node = node.parentElement) {
				if (node instanceof HTMLElement && canScroll(node, event.deltaY)) return;
			}
			event.preventDefault();
			el.scrollTop += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1);
		};
		root.addEventListener("wheel", onWheel, { passive: false });
		return () => root.removeEventListener("wheel", onWheel);
	});

	$effect(() => {
		const el = stick.scroller;
		if (!el) return;
		const onScroll = () => {
			if (!docked) return;
			if (Date.now() - geometryAt < 400) return;
			if (Date.now() - growthAt < 400) return;
			const d = el.scrollHeight - el.clientHeight - el.scrollTop;
			if (expanded) {
				if (d > COLLAPSE_DIST && !intent && !stick.isAtBottom) expanded = false;
			} else if (d < EXPAND_DIST) {
				if (requiresReveal && !revealed) return;
				expanded = true;
				stick.scrollToBottom("smooth");
			}
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	});

	$effect(() => {
		if (!pending || expanded) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Enter" || event.altKey) return;
			if (event.shiftKey && !event.metaKey && !event.ctrlKey) return;
			const target = event.target as HTMLElement | null;
			if (
				target &&
				((target.tagName === "INPUT" && (target as HTMLInputElement).type !== "range") ||
					target.tagName === "TEXTAREA" ||
					target.isContentEditable ||
					target.closest("button"))
			)
				return;
			event.preventDefault();
			import("./dictation.svelte").then(({ finishDictation }) => {
				void finishDictation().then(() => expandAndReveal());
			});
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	});

	const initialMode = untrack(() => mode);

	$effect(() => {
		void tick().then(measureBlock);
	});

	$effect(() => {
		if (!block || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => measureBlock());
		ro.observe(block);
		measureBlock();
		return () => ro.disconnect();
	});
</script>

<div class="pointer-events-none absolute inset-x-0 bottom-0" style="right: {sbInset}px">
	<div class="h-24 bg-gradient-to-t from-background via-background/85 to-transparent"></div>
	<div bind:this={block} class="relative bg-background pb-5" style="--dock-max-h: {dockMaxH ? `${dockMaxH}px` : '55dvh'}">
		<div class="mx-auto w-full max-w-[46rem] px-4">
			{@render setupCta?.()}
			<QueuedSteers steers={queuedSteers} />
			{#if pending && requiresReveal}
				<ReadingThinking
					value={readingThinking}
					onChange={(value) => onReadingThinking(value)}
					onEscape={dictationCancel}
					onOpen={!expanded ? () => {
						import("./dictation.svelte").then(({ finishDictation }) => {
							void finishDictation().then(() => expandAndReveal());
						});
					} : undefined}
					claim={revealPending}
				/>
			{/if}
			<div bind:this={shell} class="pointer-events-auto overflow-hidden rounded-2xl border bg-card shadow-lg">
				<div bind:this={content} class={mode === initialMode ? undefined : "dock-variant"}>
					{#if pending}
						{#key pending.toolCallId}
						<QuestionDock
							toolName={pending.tool as "quiz" | "probe" | "ask_user_question" | "explain" | "recall"}
							toolCallId={pending.toolCallId}
							input={pending.input}
							{expanded}
							reveal={revealPending}
							{phase}
							onExpand={expandAndReveal}
							onSubmit={onSubmitAnswer}
							onEscape={dictationCancel}
							dictationClaim={!revealPending}
							{compactionRunning}
						/>
						{/key}
					{:else if practice}
						{#key practice.toolCallId}
						<PracticeDock
							problemCallId={practice.toolCallId}
							input={practice.input as { statement: string }}
							{expanded}
							onExpand={() => {
								expanded = true;
								suppressFold();
							}}
							onSubmit={onSubmitThinking}
							onEscape={dictationCancel}
							{compactionRunning}
						/>
						{/key}
					{:else}
						{@render composer()}
					{/if}
				</div>
			</div>
			<StatsBar {turns} chatId={chatId} {dictationSlot} />
			{#if !stick.isAtBottom}
				<button
					type="button"
					aria-label="Scroll to bottom"
					onclick={() => stick.scrollToBottom()}
					class="pointer-events-auto absolute bottom-full left-[50%] mb-2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border bg-background shadow-xs hover:bg-muted"
				>
					<ArrowDown class="size-4" />
				</button>
			{/if}
		</div>
		{#if pending && plan}
			<button
				type="button"
				data-testid="plan-marginalia"
				onclick={onOpenPlan}
				style="left: calc(50% + ${DOCK_W / 2 + MARGIN_GAP}px)"
				class="absolute bottom-5 right-4 top-0 cursor-pointer transition-[filter,opacity] duration-300 ease-out {expanded && flankW >= MARGIN_MIN_W ? 'pointer-events-auto opacity-100 blur-0' : 'pointer-events-none opacity-0 blur-md'}"
			>
				{@render plan()}
			</button>
		{/if}
	</div>
</div>
