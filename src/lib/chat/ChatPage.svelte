<script lang="ts">
	import { emitAppEvent, emitKeyAction, onAppEvent, onKeyAction } from "$lib/events";
	import { abortProcess, fetchChat, fetchJobs as fetchChatJobs } from "$lib/api/chats";
	import { renameSession } from "$lib/state/sessions";
	import { settings as userSettings } from "$lib/state/settings.svelte";
	import type { ChatView } from "@/src/session/model";
import { untrack } from "svelte";
	import { onMount, setContext, tick } from "svelte";
	import { Waypoints, Dumbbell } from "@lucide/svelte";
	import { activeProblemOf, continuationSignature, dismissedAnswer, findPendingToolCall, firstSourceTextParts, messageAnchorId, messageIdFromHash, needsContinuation, phaseAt3, phaseTimeline, questionNeedsReveal, teachStepIndex, textPartMessageId, type ChatSettings, type LhMessage, type LhViewMessage, type QuestionAnswerData, type TurnUsage } from "@/src/session/model";
	import { isQuestionTool, toolQuestionKind } from "@/src/tools/model";
import { slotsConfigured } from "@/src/settings/model";
import { type GraphSnapshot } from "@/src/graph/model";
	import { visibleQueuedSteers, type SteerQueueItem } from "$lib/chat/session-core.ts";
	import Markdown from "$lib/markdown/Markdown.svelte";
	import PhaseChip from "./PhaseChip.svelte";
	import PhaseDivider from "./PhaseDivider.svelte";
	import TopBar from "./TopBar.svelte";
	import Composer from "./Composer.svelte";
	import { withCode } from "./code-input";
	import DockOverlay from "./DockOverlay.svelte";
	import SessionFind from "./SessionFind.svelte";
	import CoverageRing from "./CoverageRing.svelte";
	import AnsweredCard from "./AnsweredCard.svelte";
	import ArtifactPart from "$lib/artifacts/ArtifactPart.svelte";
	import SteerCard from "$lib/artifacts/SteerCard.svelte";
	import LiveToolCard from "$lib/artifacts/LiveToolCard.svelte";
	import PlanBlock from "./PlanBlock.svelte";
	import PlanPopup from "./PlanPopup.svelte";
	import PlanMarginalia from "./PlanMarginalia.svelte";
	import SessionOverlay from "./SessionOverlay.svelte";
	import AbortTurnDialog from "./AbortTurnDialog.svelte";
	import CompactionDivider from "./CompactionDivider.svelte";
	import GraphContextCard from "./GraphContextCard.svelte";
	import ThinkingCard from "./ThinkingCard.svelte";
	import Reasoning from "./Reasoning.svelte";
	import DictationBar from "./DictationBar.svelte";
	import SetupDialog from "$lib/settings/SetupDialog.svelte";
	import { DictationController, joinDictation } from "./dictation.svelte";
	import { SessionView } from "./session.svelte";
	import { StickToBottom } from "./stick.svelte";
	import { CHAT_ACTIONS } from "./actions-context";
	import { SESSION_MERMAID } from "./session-context";
	import { sidebar } from "$lib/state/sidebar.svelte";
	import { noProviderKey } from "$lib/state/keys.svelte";
	import { serverEvents } from "$lib/state/server-events";
	import { hint } from "$lib/hint";
	import { toggleUserThinking } from "./thinking-store.svelte";
	import { scrollSessionTarget } from "./session-nav";
	import {
		escAbortTarget,
		initialPromptOwed,
		parseModelsRefusal,
		parseModelUnavailableRefusal,
		parseProviderKeyRefusal,
	} from "./chat-logic";

	type Props = {
		chatId: string;
		title: string;
		kind?: "teach" | "practice";
		initialMessages: LhMessage[];
		initialPrompt?: string;
		initiallyInFlight?: boolean;
		initiallyCompacting?: boolean;
		initialConfigured?: boolean;
	};
	let {
		chatId,
		title,
		kind = "teach",
		initialMessages,
		initialPrompt,
		initiallyInFlight,
		initiallyCompacting = false,
		initialConfigured = false,
	}: Props = $props();

	const stick = new StickToBottom();
	const session = new SessionView({ chatId: untrack(() => chatId), initialMessages: untrack(() => initialMessages) });

	const messages = $derived(session.state.messages);
	const nativeMessages = $derived(session.state.nativeMessages);
	const status = $derived(session.state.status);
	const error = $derived(session.state.error);
	const steerQueue = $derived(session.state.steerQueue);

	let turnInFlight = $state(untrack(() => initiallyInFlight ?? false));
	let compacting = $state(untrack(() => initiallyCompacting));
	let compactionRevision = 0;
	let text = $state("");
	let code = $state("");
	let textMirror = "";
	let configured = $derived(userSettings.record === undefined ? initialConfigured : slotsConfigured(userSettings.record?.models));
	let setupOpen = $state(false);
	let turns = $state.raw<TurnUsage[]>([]);
	let jobs = $state.raw<import("@/src/jobs/model").JobRecord[]>([]);
	let coverageTick = $state(0);
	let dockReserve = $state(208);
	let planOpen = $state(false);
	let mermaidFocus = $state<string | null>(null);
	let figureFocus = $state<{ svg: string; inverted: boolean } | null>(null);
	let abortAsk = $state<"turn" | "question" | "problem" | null>(null);
	let readingThinking = $state("");
	let titleText = $state(untrack(() => title));
	let renaming = $state(false);
	let titleDraft = $state("");
	let titleInput = $state<HTMLInputElement | null>(null);
	let scroller = $state<HTMLElement | null>(null);
	let contentEl = $state<HTMLElement | null>(null);
	let scope = $state<HTMLDivElement | null>(null);
	let flashTimer: ReturnType<typeof setTimeout> | undefined;
	let lastJump: { hash: string; target: HTMLElement } | null = null;
	let sentInitial = false;
	let mountContinuation = false;
	let continuedTail: string | null = null;
	let draft: { text: string; code: string } | null = null;
	let handlingRefusal = false;
	let pendingSync = false;
	let jobStatuses = new Map<string, string>();
	let firstJobsFetch = true;
	let jobsDebounce: ReturnType<typeof setTimeout> | undefined;
	let turnTimers: ReturnType<typeof setTimeout>[] = [];
	let adoptionWindow = false;

	const dictation = new DictationController((value) => {
		applyText(joinDictation(textMirror, value));
	});

	function applyText(value: string): void {
		textMirror = value;
		text = value;
	}

	const pending = $derived(findPendingToolCall(messages as never));
	const activeProblem = $derived(activeProblemOf(nativeMessages));
	const phases = $derived(phaseTimeline(messages));
	const localStream = $derived(status === "submitted" || status === "streaming");
	const busy = $derived(localStream || turnInFlight);
	const sourceTextParts = $derived(firstSourceTextParts(messages));
	const planTree = $derived.by(() => {
		for (let m = messages.length - 1; m >= 0; m--) {
			const parts = messages[m]?.parts ?? [];
			for (let p = parts.length - 1; p >= 0; p--) {
				const part = parts[p]!;
				if (!part.type.startsWith("tool-plan_") || part.state !== "output-available") continue;
				const tree = (part.output as { tree?: import("@/src/session/model").PlanTree } | undefined)?.tree;
				if (tree && Array.isArray(tree.nodes)) return tree;
			}
		}
		return null;
	});
	const hasPlan = $derived(!!planTree && planTree.nodes.length > 0);
	const requiresReveal = $derived(pending !== null && questionNeedsReveal(pending.tool, pending.input, phaseAt3(messages)));
	const queuedSteers = $derived(visibleQueuedSteers(steerQueue, nativeMessages)) as SteerQueueItem[];

	const canSend = $derived((text.trim().length > 0 || code.trim().length > 0 || dictation.active) && !pending && !activeProblem && !compacting);
	const nextReady = $derived(
		kind === "practice" &&
			!pending &&
			!activeProblem &&
			!compacting &&
			!busy &&
			nativeMessages.some(
				(m) =>
					(m as { role?: string }).role === "assistant" &&
					Array.isArray((m as { content?: unknown[] }).content) &&
					(m as { content: Array<{ type?: string; name?: string }> }).content.some(
						(b) => b.type === "toolCall" && b.name === "problem",
					),
			),
	);

	setContext(CHAT_ACTIONS, {
		chatId: untrack(() => chatId),
		syncFromServer: () => syncFromServer(),
		sendText: (value: string) => session.send({ type: "text", text: value }),
		openSetup: () => (setupOpen = true),
	});
	setContext(SESSION_MERMAID, {
		openMermaid: (chart: string) => (mermaidFocus = chart),
		openFigure: (svg: string, inverted: boolean) => (figureFocus = { svg, inverted }),
	});

	session.setReattachSettled(() => {
		turnInFlight = false;
		void syncFromServer();
	});

	/** The chat's record, or null after logging why it could not be read. */
	async function readRecord(): Promise<ChatView | null> {
		try {
			return await fetchChat(chatId);
		} catch (error) {
			console.error(`[chat ${chatId}] record load failed:`, error);
			return null;
		}
	}

	async function syncTurns(): Promise<void> {
		const record = await readRecord();
		if (record?.turns) turns = record.turns;
	}

	function autoContinue(next: LhMessage[]): void {
		if (!needsContinuation(next)) {
			continuedTail = null;
			return;
		}
		const tail = continuationSignature(next);
		if (continuedTail === tail) return;
		continuedTail = tail;
		session.send({ type: "continue" });
	}

	async function syncFromServer(): Promise<void> {
		const record = await readRecord();
		if (!record) return;
		if (record.turns) turns = record.turns;
		session.setMessages(record.messages);
		if (status === "ready") autoContinue(record.messages);
	}

	async function syncCompaction(): Promise<void> {
		const revision = ++compactionRevision;
		const record = await readRecord();
		// A frame that arrived after the read started owns the state.
		if (!record || revision !== compactionRevision) return;
		compacting = record.compacting;
	}

	async function adoptAppendOnly(): Promise<void> {
		const record = await readRecord();
		if (record) session.adoptRecord(record.messages);
	}

	async function fetchJobs(): Promise<void> {
		try {
			const data = await fetchChatJobs(chatId);
			const list = data.jobs;
			for (const job of list) {
				const previous = jobStatuses.get(job.id);
				if (previous === "running" && job.status !== "running") {
					if (localStream || data.turnInFlight === true) {
						pendingSync = true;
						void adoptAppendOnly();
					} else {
						void syncFromServer();
					}
				}
				jobStatuses.set(job.id, job.status);
			}
			if (pendingSync && !localStream && data.turnInFlight !== true) {
				pendingSync = false;
				void syncFromServer();
			}
			jobs = list;
			firstJobsFetch = false;
		} catch (error) {
			console.error(`[chat ${chatId}] jobs load failed:`, error);
		}
	}

	function scheduleJobs() {
		clearTimeout(jobsDebounce);
		jobsDebounce = setTimeout(() => void fetchJobs(), 250);
	}

	function doSend(): void {
		if (busy || pending || compacting) return;
		const value = withCode(textMirror, code).trim();
		if (!value) return;
		draft = { text: textMirror, code };
		applyText("");
		code = "";
		session.send({ type: "text", text: value });
	}

	function doSteerOrSend(): void {
		if (pending || compacting) return;
		const value = withCode(textMirror, code).trim();
		if (!value) return;
		if (busy) {
			applyText("");
			code = "";
			session.steer(value);
			return;
		}
		doSend();
	}

	function onSend(): void {
		if (pending || compacting) return;
		if (!dictation.active) {
			doSteerOrSend();
			return;
		}
		void dictation.finish().then(() => doSteerOrSend());
	}

	function sendNext(): void {
		if (!nextReady) return;
		session.send({ type: "next" });
	}

	function submitThinking(value: string): void {
		if (!activeProblem) return;
		session.send({ type: "thinking", problemCallId: activeProblem.toolCallId, text: value });
	}

	function abortInFlightTurn(): void {
		session.stop();
		abortProcess("turn", chatId).catch((error) => console.error(`[chat ${chatId}] turn abort failed:`, error));
	}

	function confirmAbort(mode: "turn" | "question" | "problem"): void {
		abortAsk = null;
		if (mode === "turn") {
			abortInFlightTurn();
			return;
		}
		if (pending) {
			const question = ((pending.input as { question?: string } | null)?.question ?? "") as string;
			const reading = readingThinking.trim() || undefined;
			readingThinking = "";
			const answer = dismissedAnswer(toolQuestionKind(pending.tool), question);
			session.dismissQuestion(pending.toolCallId, reading ? { ...answer, readingThinking: reading } : answer);
			if (busy) abortInFlightTurn();
			return;
		}
		if (activeProblem) {
			session.dismissProblem(activeProblem.toolCallId);
			if (busy) abortInFlightTurn();
		}
	}

	async function commitRename(next: string): Promise<void> {
		renaming = false;
		const value = next.trim();
		if (!value || value === titleText) return;
		try {
			await renameSession(chatId, value);
			titleText = value;
		} catch (error) {
			console.error(`[chat ${chatId}] rename failed:`, error);
		}
	}

	function beginRename(): void {
		titleDraft = titleText;
		renaming = true;
	}

	function jumpToHash(): boolean {
		const hash = window.location.hash;
		const messageId = messageIdFromHash(hash);
		if (!messageId || !scope) return false;
		const target = document.getElementById(messageAnchorId(messageId));
		if (!target || !scope.contains(target)) return false;
		if (lastJump?.hash === hash && lastJump.target === target) return true;
		stick.stopScroll();
		if (!scope) return false;
		scrollSessionTarget(target, scope!, stick.scroller, () => stick.stopScroll());
		if (flashTimer) clearTimeout(flashTimer);
		target.classList.add("lh-source-highlight");
		flashTimer = setTimeout(() => target.classList.remove("lh-source-highlight"), 2000);
		lastJump = { hash, target };
		return true;
	}

	$effect(() => {
		if (!scroller) return;
		stick.attach(scroller!);
		return () => stick.detach(scroller!);
	});
	$effect(() => {
		if (!contentEl) return;
		stick.attachContent(contentEl!);
		return () => stick.detachContent();
	});
	$effect(() => {
		if (!renaming || !titleInput) return;
		titleInput.focus();
		titleInput.select();
	});

	let previousRunning = $state(untrack(() => status === "submitted" || status === "streaming"));
	$effect(() => {
		const running = status === "submitted" || status === "streaming";
		if (running === previousRunning) return;
		previousRunning = running;
		emitAppEvent("turn-state", { id: chatId, running });
	});

	let previousStatus = $state(untrack(() => status));
	$effect(() => {
		const was = previousStatus;
		previousStatus = status;
		if (was === status) return;
		if (turnInFlight && (status === "submitted" || status === "streaming")) turnInFlight = false;
		if (was !== "ready" && status === "ready") {
			void syncTurns();
			coverageTick += 1;
			void syncFromServer();
		}
	});

	$effect(() => {
		const start = status === "submitted";
		if (!start) return;
		adoptionWindow = true;
		for (const ms of [400, 1000, 2000]) {
			turnTimers.push(
				setTimeout(() => {
					if (adoptionWindow) void adoptAppendOnly();
				}, ms),
			);
		}
	});

	$effect(() => {
		if (!error || handlingRefusal) return;
		const missing = parseModelsRefusal(error.message);
		const keyRefused = parseProviderKeyRefusal(error.message);
		const unavailable = parseModelUnavailableRefusal(error.message);
		if (!missing && !keyRefused && !unavailable) return;
		handlingRefusal = true;
		let cancelled = false;
		void (async () => {
			const record = await readRecord();
			if (cancelled) return;
			if (record) session.setMessages(record.messages);
			if (draft !== null) {
				applyText(draft.text);
				code = draft.code;
				draft = null;
			}
			if (unavailable && !record) {
				handlingRefusal = false;
				return;
			}
			session.stop();
			session.clearError();
			if (unavailable) emitKeyAction("open-model-picker");
			else setupOpen = true;
			handlingRefusal = false;
		})();
		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		if (typeof window === "undefined") return;
		const offs = [
			serverEvents.subscribe("turn-started", (payload) => {
				if (payload.chatId !== chatId || localStream || turnInFlight) return;
				turnInFlight = true;
				session.resumeStream();
			}),
			serverEvents.subscribe("turn-settled", (payload) => {
				if (payload.chatId !== chatId) return;
				if (localStream) return;
				if (turnInFlight) {
					if (status === "error") {
						turnInFlight = false;
						session.clearError();
						void syncFromServer();
					}
					return;
				}
				void syncFromServer();
			}),
			serverEvents.subscribe("compaction-changed", (payload) => {
				if (payload.chatId !== chatId) return;
				compactionRevision += 1;
				compacting = payload.running;
			}),
			serverEvents.subscribe("record-changed", (payload) => {
				if (payload.chatId !== chatId || localStream || turnInFlight) return;
				void syncFromServer();
			}),
			serverEvents.subscribe("jobs-changed", (payload) => {
				if (payload.chatId != null && payload.chatId !== chatId) return;
				scheduleJobs();
			}),
			serverEvents.onResync(() => {
				void fetchJobs();
				void syncCompaction();
			}),
		];
		return () => {
			for (const off of offs) off();
		};
	});


	onMount(() => {
		// Initial pin: fonts, KaTeX and images land after the first paint;
		// the baseline opens a session at the exact bottom. An explicit hash
		// (an anchor arrival) owns the position instead.
		if (!window.location.hash) {
			void tick().then(() => stick.scrollToBottom("instant"));
			setTimeout(() => { if (!window.location.hash) stick.scrollToBottom("instant"); }, 300);
			setTimeout(() => { if (!window.location.hash) stick.scrollToBottom("instant"); }, 900);
		}
		const unmountDictation = dictation.mount();
		void fetchJobs();
		void syncTurns();
		void syncCompaction();
		// A mount full sync would replace the view while the ?prompt send is optimistic.

		if (initialPromptOwed(initialMessages, initialPrompt) && initialPrompt) {
			sentInitial = true;
			session.send({ type: "text", text: initialPrompt });
		}
		if (initiallyInFlight) session.resumeStream(false);
		if (!mountContinuation) {
			mountContinuation = true;
			if (!turnInFlight && status === "ready") autoContinue(initialMessages);
		}

		const offRename = onKeyAction("rename-session", () => beginRename());
		const offRenamed = onAppEvent("chat-renamed", ({ id, title: next }) => {
			if (id === chatId) titleText = next;
		});
		const onAbort = () => {
			const target = escAbortTarget({
				abortAsk: abortAsk !== null,
				mermaidFocus: mermaidFocus !== null || figureFocus !== null,
				planOpen,
				setupOpen,
				pending: pending !== null,
				problem: activeProblem !== null,
				busy,
			});
			if (target === "question" || target === "problem" || target === "turn") abortAsk = target;
			else if (target === "mermaid") {
				mermaidFocus = null;
				figureFocus = null;
			} else if (target === "plan") planOpen = false;
		};
		const offAbort = onKeyAction("abort-turn", onAbort);
		const offToggleThinking = onKeyAction("toggle-user-thinking", () => toggleUserThinking());

		let hashTicks = 0;
		const hashTimer = window.location.hash
			? window.setInterval(() => {
					if (++hashTicks > 300) {
						clearInterval(hashTimer);
						return;
					}
					jumpToHash();
				}, 64)
			: undefined;
		const onHash = () => {
			lastJump = null;
			if (flashTimer) clearTimeout(flashTimer);
			document.querySelector(".lh-source-highlight")?.classList.remove("lh-source-highlight");
			jumpToHash();
		};
		window.addEventListener("hashchange", onHash);
		window.addEventListener("popstate", onHash);

		return () => {
			unmountDictation();
			session.stop();
			for (const timer of turnTimers) clearTimeout(timer);
			clearTimeout(jobsDebounce);
			if (hashTimer) clearInterval(hashTimer);
			if (flashTimer) clearTimeout(flashTimer);
			offRename();
			offRenamed();
			offAbort();
			offToggleThinking();
			window.removeEventListener("hashchange", onHash);
			window.removeEventListener("popstate", onHash);
		};
	});

	async function submitAnswer(output: QuestionAnswerData): Promise<void> {
		if (!pending) return;
		const reading = readingThinking.trim() || undefined;
		readingThinking = "";
		session.submitAnswer(pending.tool, pending.toolCallId, reading ? { ...output, readingThinking: reading } : output);
	}
</script>

{#snippet composer()}
	<Composer
		busy={busy}
		value={text}
		{code}
		onCodeChange={(value) => (code = value)}
		onChange={applyText}
		onSend={onSend}
		onStop={abortInFlightTurn}
		canSend={canSend}
		onEscape={dictation.active ? dictation.cancel : undefined}
		nextProblem={nextReady}
		onNext={sendNext}
		placeholder={nextReady ? "Ask anything, or press Enter for the next one." : undefined}
	/>
{/snippet}

{#snippet dictationSlot()}
	<DictationBar {dictation} />
{/snippet}

{#snippet setupCta()}
	{#if noProviderKey.value}
		<div class="pointer-events-auto mb-2 flex justify-center">
			<button type="button" data-testid="setup-cta-keys" onclick={() => (setupOpen = true)} class="cursor-pointer rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent">Add a provider key</button>
		</div>
	{:else if !configured}
		<div class="pointer-events-auto mb-2 flex justify-center">
			<button type="button" data-testid="setup-cta" onclick={() => (setupOpen = true)} class="cursor-pointer rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent">Set up your models</button>
		</div>
	{/if}
{/snippet}

<div class="flex h-dvh">
	<div class="flex min-w-0 flex-1 flex-col">
		<TopBar
			drag={!renaming}
			onMouseDown={(event) => {
				if (renaming && event.target !== titleInput) titleInput?.blur();
			}}
		>
			{#if renaming}
				<input
					bind:this={titleInput}
					value={titleDraft}
					oninput={(event) => (titleDraft = (event.currentTarget as HTMLInputElement).value)}
					onkeydown={(event) => {
						if (event.key === "Enter") void commitRename(titleDraft);
						else if (event.key === "Escape") {
							event.stopPropagation();
							renaming = false;
						}
					}}
					onblur={() => void commitRename(titleDraft)}
					spellcheck={false}
					aria-label="Session title"
					title="Rename this session"
					class="lh-no-drag min-w-[8ch] max-w-[70%] shrink-0 bg-transparent font-title text-3xl tracking-tight caret-current outline-none [field-sizing:content]"
				/>
				<div class="min-w-4 flex-1" aria-hidden="true"></div>
			{:else}
				<button
					type="button"
					onclick={beginRename}
					{@attach hint("Rename session", { action: "rename-session", side: "bottom" })}
					class="lh-no-drag -mx-1.5 min-w-4 shrink cursor-text truncate rounded-md px-1.5 text-left font-title text-3xl tracking-tight transition-colors hover:bg-accent"
				>{titleText}</button>
				<div class="min-w-4 flex-1" aria-hidden="true"></div>
			{/if}
			{#if planTree}
				<button
					type="button"
					data-testid="plan-chip"
					onclick={(event) => {
						if (event.detail !== 0) (event.currentTarget as HTMLElement).blur();
						planOpen = true;
					}}
					{@attach hint("Open the full plan", { side: "bottom" })}
					class="lh-no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground"
				>
					<Waypoints class="size-3.5 text-primary" aria-hidden="true" />
					Plan
				</button>
			{/if}
			{#if kind !== "practice"}
				<CoverageRing {chatId} refreshKey={coverageTick} />
			{/if}
			{#if kind === "practice"}
				<span data-testid="phase-chip" data-phase="practice" aria-hidden="true" class="pointer-events-none flex shrink-0 select-none items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					<Dumbbell class="size-3" />
					Practice
				</span>
			{:else}
				<PhaseChip phase={phases.at(-1) ?? "probe"} />
			{/if}
		</TopBar>

		<SessionFind {scope} scrollTo={(range) => {
			if (!scope) return;
			stick.stopScroll();
			scrollSessionTarget(range, scope, stick.scroller, () => stick.stopScroll());
		}} />

		<div bind:this={scope} class="relative flex min-h-0 flex-1">
			<div class="flex h-full min-w-0 flex-1 flex-col">
				<div bind:this={scroller} class="relative flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]" role="log">
					<div bind:this={contentEl} class="flex min-h-full flex-col gap-0 p-0">
						<div data-session-find-root="" class="mx-auto flex w-full max-w-none flex-1 flex-col gap-4 px-6 pt-4">
							{#if messages.length === 0 && !busy}
								<div class="flex size-full flex-col items-center justify-center gap-3 p-8 text-center">
									<div class="space-y-1">
										<h3 class="font-medium text-sm">New session</h3>
										<p class="text-muted-foreground text-sm">The teacher will open by probing what you already know.</p>
									</div>
								</div>
							{/if}

							{#each messages as message, mi (message.id || `m-${mi}`)}
								{#if message.role === "user" && (message.metadata as { subagentResult?: unknown } | undefined)?.subagentResult != null}
									<SteerCard {message} />
								{:else if message.role === "user" && message.parts.some((p) => p.type === "data-probe-handoff")}
									<PhaseDivider phase="plan" />
								{:else if message.role === "user" && message.parts.length > 0 && message.parts.every((p) => p.type.startsWith("data-"))}
									{#each message.parts as part, pi (pi)}
										{#if part.type === "data-graph-context"}
											<GraphContextCard data={part.data as { propositions: { id: string; name: string; statement: string }[]; chains: string[] }} />
										{:else if part.type === "data-compaction"}
											<CompactionDivider data={part.data as { content: string; details: import("@/src/session/model").CompactionDetails }} />
										{:else if part.type === "data-compaction-cut"}
											<CompactionDivider data={part.data as { content: string; details: import("@/src/session/model").CompactionDetails }} cut />
										{:else if part.type === "data-practice-thinking"}
											<ThinkingCard data={part.data as { problemCallId: string; text: string }} />
										{:else if part.type === "data-practice-next"}
											<div data-testid="practice-next-line" class="my-4 flex items-center justify-center gap-1.5 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
												<span aria-hidden="true">→</span>
												Next problem
											</div>
										{/if}
									{/each}
								{:else}
									{#if message.role === "assistant" && mi > 0 && phases[mi] === "teach" && phases[mi - 1] !== "teach" && teachStepIndex(message.parts) === -1}
										<PhaseDivider phase="teach" />
									{/if}
									{#if message.role === "user"}
										<div data-testid="user-message" class="my-2 w-full border-l-[calc(3ch-14px)] border-muted-foreground/30 bg-card py-1 pl-[14px] pr-4 font-ui text-xs">
											<div class="font-medium uppercase tracking-wide text-muted-foreground">You</div>
											<div class="text-foreground">
												<Markdown text={message.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")} />
											</div>
										</div>
									{:else}
										<div class="group flex w-full max-w-full flex-col gap-2">
											<div class="flex w-full min-w-0 max-w-full flex-col gap-2 text-sm text-foreground">
												{#each message.parts as part, pi (part.id || pi)}
													{@const isLastPart = mi === messages.length - 1 && pi === message.parts.length - 1}
													{@const teachBoundary = message.role === "assistant" && mi > 0 && phases[mi] === "teach" && phases[mi - 1] !== "teach" && teachStepIndex(message.parts) === pi}
													{#if part.state === "output-error" && part.type.startsWith("tool-") && part.errorText !== "Operation aborted"}
														<div data-testid="tool-retry" class="flex items-center justify-center gap-1.5 py-1 text-xs text-muted-foreground">Retrying…</div>
													{:else if part.type === "text"}
														{@const sourceId = textPartMessageId(part.id)}
														{@const anchor = sourceId && sourceTextParts.get(sourceId) === part.id ? messageAnchorId(sourceId) : undefined}
														<div id={anchor} data-source-message-id={sourceId ?? undefined} class="lh-source-passage">
															<Markdown text={part.text ?? ""} />
														</div>
													{:else if part.type === "reasoning"}
														<Reasoning text={part.text ?? ""} isStreaming={status === "streaming" && isLastPart} />
													{:else if part.type === "step-start"}
														{#if teachBoundary}
															<PhaseDivider phase="teach" />
														{:else if pi > 0}
															<hr class="my-3 border-border" />
														{/if}
													{:else if part.type === "data-plan-block"}
														<PlanBlock data={part.data as import("@/src/session/model").PlanBlockData} onOpen={() => (planOpen = true)} />
													{:else if part.type.startsWith("tool-") && isQuestionTool(part.type.slice("tool-".length))}
														{#if part.state === "output-available"}
															<AnsweredCard answer={part.output as QuestionAnswerData} input={part.input} />
														{/if}
													{:else if part.type.startsWith("tool-") && part.state === "input-streaming"}
														<LiveToolCard part={part as never} />
													{:else if part.type.startsWith("tool-")}
														<ArtifactPart part={part as never} {jobs} />
													{/if}
												{/each}
											</div>
										</div>
									{/if}
								{/if}
							{/each}

							{#if compacting}
								<span class="flex items-center gap-2 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
									<span class="animate-pulse">COMPACTING CONTEXT…</span>
								</span>
							{/if}
							{#if status === "submitted" || turnInFlight}
								<span class="flex items-center gap-2 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
									<span class="animate-pulse">THINKING…</span>
								</span>
							{/if}
							{#if error}
								<div class="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">Something went wrong: {error.message}</div>
							{/if}
						</div>
						<div aria-hidden="true" data-testid="dock-spacer" style="height: {dockReserve}px"></div>
					</div>
				</div>

				<DockOverlay
					{pending}
					practice={activeProblem}
					compactionRunning={compacting}
					{requiresReveal}
					{readingThinking}
					onReadingThinking={(value) => (readingThinking = value)}
					phase={phases.at(-1) ?? "probe"}
					{turns}
					{chatId}
					{composer}
					onSubmitAnswer={(output) => void submitAnswer(output)}
					onSubmitThinking={submitThinking}
					{dictationSlot}
					dictationCancel={dictation.active ? dictation.cancel : undefined}
					{setupCta}
					{queuedSteers}
					plan={hasPlan ? planMarginalia : undefined}
					onOpenPlan={() => (planOpen = true)}
					{stick}
					onReserve={(height) => (dockReserve = height)}
				/>
			</div>

			{#if mermaidFocus !== null}
				<SessionOverlay chart={mermaidFocus} onClose={() => (mermaidFocus = null)} />
			{/if}
			{#if figureFocus !== null}
				<SessionOverlay svg={figureFocus.svg} inverted={figureFocus.inverted} onClose={() => (figureFocus = null)} />
			{/if}
			{#if planOpen}
				<PlanPopup messages={messages} onClose={() => (planOpen = false)} />
			{/if}
			<AbortTurnDialog mode={abortAsk} onClose={() => (abortAsk = null)} onConfirm={confirmAbort} busy={busy} />
		</div>
	</div>
</div>

{#snippet planMarginalia()}
	<PlanMarginalia messages={messages} />
{/snippet}

<SetupDialog
	open={setupOpen}
	onClose={() => (setupOpen = false)}
	onDone={() => {
		setupOpen = false;
		configured = true;
	}}
/>
