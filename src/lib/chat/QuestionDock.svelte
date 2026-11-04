<script lang="ts">
	import { ArrowDown, ChevronRight, Play } from "@lucide/svelte";
	import {
		buildAnswer,
		CONFIDENCE_STOPS,
		DEFAULT_CONFIDENCE_INDEX,
		emptyDockSelection,
		normalizeOptions,
		normalizeQuizType,
		parseAskInput,
		parseExplainInput,
		parseQuizInput,
		repairMathForDisplay,
		resolveCorrect,
		seededRandom,
		shuffleOptions,
		toggleOption,
		toggleOther,
		toolQuestionKind,
		type AnswerRequest,
		type DockSelection,
		type Phase3,
		type QuestionAnswerData,
		type QuestionData,
	} from "@/src/core";
	import { CONFIDENCE_COLORS, confidenceRailStyle } from "./confidence";
	import { enterSubmits } from "./enter-submits";
	import CodeInput from "./CodeInput.svelte";
	import { withCode } from "./code-input";
	import { finishDictation, isDictationActive, joinDictation, setDictationTarget } from "./dictation.svelte";
	import Markdown from "$lib/markdown/Markdown.svelte";
	import { cn } from "$lib/utils";

	let {
		toolName,
		toolCallId,
		input,
		expanded,
		reveal = false,
		onExpand,
		onSubmit,
		onEscape,
		phase = "probe",
		dictationClaim = true,
		compactionRunning = false,
	}: {
		toolName: "quiz" | "probe" | "ask_user_question" | "explain" | "recall";
		toolCallId: string;
		input: unknown;
		expanded: boolean;
		reveal?: boolean;
		onExpand: () => void;
		onSubmit: (output: QuestionAnswerData) => void;
		onEscape?: () => void;
		phase?: Phase3;
		dictationClaim?: boolean;
		compactionRunning?: boolean;
	} = $props();

	const canonical = $derived(toolName === "probe" ? "quiz" : toolName === "recall" ? "explain" : toolName);
	const toolLabel = $derived(toolName === "probe" ? "Probe" : toolName === "recall" ? "Recall" : undefined);
	const parsed = $derived(
		canonical === "quiz" ? parseQuizInput(input) : canonical === "explain" ? parseExplainInput(input) : parseAskInput(input),
	);

	const kind = $derived(toolQuestionKind(toolName));
	const qd = $derived.by((): QuestionData | null => {
		if (!parsed) return null;
		const quizInput = kind === "quiz" ? (input as ReturnType<typeof parseQuizInput>) : null;
		const askInput = kind === "ask" ? (input as ReturnType<typeof parseAskInput>) : null;
		const explainInput = kind === "explain" ? (input as ReturnType<typeof parseExplainInput>) : null;
		const withMulti = input as { multiSelect?: boolean } | null;
		const multi = withMulti?.multiSelect === true;
		const mode =
			kind === "quiz"
				? multi
					? "multi-select"
					: "single-select"
				: askInput?.options?.length
					? multi
						? "multi-select"
						: "single-select"
					: "text";
		const options = normalizeOptions(((quizInput?.options ?? askInput?.options ?? []) as { label: string; value?: string }[]) ?? []);
		const ordered = kind === "quiz" && options.length > 0 ? shuffleOptions(options, seededRandom(toolCallId)) : options;
		const question: QuestionData = {
			id: toolCallId,
			kind,
			questionType: kind === "quiz" ? normalizeQuizType((input as { type?: unknown } | null)?.type) : undefined,
			question: parsed!.question,
			context: parsed!.details,
			mode,
			options: ordered,
			createdAt: new Date().toISOString(),
		};
		if (quizInput) {
			const resolved = resolveCorrect(quizInput.correctAnswer, ordered);
			question.correctIndices = resolved.indices;
			question.explanation = quizInput.explanation;
		}
		if (explainInput) question.committedAnswer = explainInput.correctAnswer;
		return question;
	});

	let sel = $state<DockSelection>(emptyDockSelection());
	let thinking = $state("");
	let other = $state("");
	let text = $state("");
	let code = $state("");
	let thinkingRefValue = "";
	let answerRefValue = "";
	let confIdx = $state(DEFAULT_CONFIDENCE_INDEX);
	let kbdIdx = $state<number | null>(null);
	let root = $state<HTMLDivElement | null>(null);
	let prose = $state<HTMLTextAreaElement | null>(null);
	let thinkingEl = $state<HTMLTextAreaElement | null>(null);
	let otherEl = $state<HTMLInputElement | null>(null);

	const selectMode = $derived(qd?.mode === "multi-select" ? "multi-select" : "single-select");
	const optionCount = $derived(qd?.mode === "text" ? 0 : (qd?.options.length ?? 0));
	const rowCount = $derived(qd?.mode === "text" ? 0 : optionCount + 1);
	const canSubmit = $derived(
		qd?.mode === "text"
			? text.trim().length > 0 || code.trim().length > 0
			: sel.dontKnow || (sel.otherSelected && other.trim().length > 0) || sel.selected.size > 0,
	);

	$effect(() => {
		if (!dictationClaim) return;
		setDictationTarget((t) => {
			if (qd?.mode === "text") {
				const v = joinDictation(answerRefValue, t);
				answerRefValue = v;
				text = v;
			} else {
				const v = joinDictation(thinkingRefValue, t);
				thinkingRefValue = v;
				thinking = v;
			}
		});
		return () => setDictationTarget(null);
	});

	function teaserText(question: string): string {
		return repairMathForDisplay(question)
			.replace(/\\\(([\s\S]*?)\\\)/g, "$1")
			.replace(/\\\[([\s\S]*?)\\\]/g, "$1")
			.replace(/\$\$?([^$]*)\$\$?/g, "$1")
			.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "$1/$2")
			.replace(/\\([a-zA-Z]+)/g, "$1")
			.replace(/[{}]/g, "")
			.replace(/\s+/g, " ")
			.trim();
	}

	function toggle(idx: number) {
		sel = toggleOption(selectMode, sel, idx);
	}
	function selectOther() {
		sel = toggleOther(selectMode, sel);
	}

	function doSubmit() {
		if (!qd || !canSubmit) return;
		const request: AnswerRequest = {
			dontKnow: sel.dontKnow,
			values: [...sel.selected].map((i) => qd.options[i]!.value),
			other: sel.otherSelected ? other : undefined,
			text: qd.mode === "text" ? withCode(answerRefValue, code) : undefined,
			thinking: qd.mode !== "text" ? withCode(thinkingRefValue.trim(), code) || undefined : undefined,
			confidence: kind === "quiz" ? CONFIDENCE_STOPS[confIdx] : undefined,
		};
		onSubmit(buildAnswer(qd, request, toolName));
	}
	function submit() {
		if (!canSubmit || compactionRunning) return;
		if (!isDictationActive()) {
			doSubmit();
			return;
		}
		void finishDictation().then(doSubmit);
	}

	$effect(() => {
		if (!expanded || rowCount === 0) return;
		const onKeyDown = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			const typing =
				!!target &&
				((target.tagName === "INPUT" && (target as HTMLInputElement).type !== "range") ||
					target.tagName === "TEXTAREA" ||
					target.isContentEditable);
			const modded = event.altKey || event.metaKey || event.ctrlKey;
			if (event.key === "Tab" && !event.shiftKey && !modded) {
				event.preventDefault();
				event.stopPropagation();
				if (target?.closest?.("[data-kbdrow]")) thinkingEl?.focus();
				else {
					const idx = kbdIdx ?? 0;
					kbdIdx = idx;
					focusRow(idx);
				}
				return;
			}
			if (typing || modded) return;
			if (event.key === "ArrowDown") {
				event.preventDefault();
				const next = Math.min((kbdIdx ?? -1) + 1, rowCount - 1);
				kbdIdx = next;
				if (target?.closest?.("[data-kbdrow]")) focusRow(next);
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				const next = Math.max((kbdIdx ?? rowCount) - 1, 0);
				kbdIdx = next;
				if (target?.closest?.("[data-kbdrow]")) focusRow(next);
			} else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
				if (kind !== "quiz" || sel.dontKnow) return;
				event.preventDefault();
				confIdx = Math.min(CONFIDENCE_STOPS.length - 1, Math.max(0, confIdx + (event.key === "ArrowRight" ? 1 : -1)));
			} else if (event.key === " ") {
				if (kbdIdx === null) return;
				event.preventDefault();
				kbdAct(kbdIdx);
			} else if (event.key === "Enter") {
				if (kbdIdx === null || !canSubmit) return;
				event.preventDefault();
				submit();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	});

	function focusRow(idx: number) {
		const row = root?.querySelector<HTMLElement>(`[data-kbdrow="${idx}"]`);
		const el = (row?.querySelector("input") as HTMLElement | null) ?? row;
		el?.focus();
	}

	function kbdAct(idx: number) {
		if (idx < optionCount) toggle(idx);
		else if (kind === "quiz") sel = { ...sel, selected: new Set(), otherSelected: false, dontKnow: !sel.dontKnow };
		else if (sel.otherSelected) sel = { ...sel, otherSelected: false, dontKnow: false };
		else {
			otherEl?.focus();
			selectOther();
		}
	}

	$effect(() => {
		if (kbdIdx === null) return;
		root?.querySelector<HTMLElement>(`[data-kbdrow="${kbdIdx}"]`)?.scrollIntoView({ block: "nearest" });
	});
</script>

{#snippet bar()}
	{#if reveal}
		<button
			type="button"
			data-testid="teach-check-reveal"
			onclick={onExpand}
			class="dock-variant flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
		>
			<span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary"><Play class="size-3.5" /></span>
			<span class="min-w-0 flex-1">
				<span class="block text-sm font-medium">Check your understanding</span>
				<span class="block truncate text-xs text-muted-foreground">{parsed ? teaserText(parsed.question) : ""}</span>
			</span>
			<span class="flex shrink-0 items-center gap-1 text-xs font-medium text-primary">Open <ChevronRight class="size-3.5" /></span>
		</button>
	{:else}
		<button
			type="button"
			data-testid="question-dock-bar"
			onclick={onExpand}
			class="dock-variant flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors hover:bg-accent/40"
		>
			<span class="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{canonical === "quiz" && qd?.questionType === "predict" ? "Prediction" : toolLabel ?? (canonical === "quiz" ? "Check" : canonical === "explain" ? "Explain" : "Question")}
			</span>
			<span class="min-w-0 flex-1 truncate text-muted-foreground">{parsed ? teaserText(parsed.question) : ""}</span>
			<span class="flex shrink-0 items-center gap-1 text-xs font-medium">Answer <ArrowDown class="size-3.5" /></span>
		</button>
	{/if}
{/snippet}

{#if !parsed}
	<div data-testid="malformed-question" class="rounded-xl border border-dashed bg-card/60 p-3 text-sm text-muted-foreground">
		This question arrived malformed — the transcript keeps the retry.
	</div>
{:else}
	{#if !expanded}{@render bar()}{/if}
	<div class={expanded ? "dock-variant" : "invisible h-0 overflow-hidden"}>
		{#if qd}
			<div bind:this={root} data-testid="question-dock" {@attach enterSubmits(submit)}>
				<div data-session-find-root="" class="max-h-[var(--dock-max-h,55dvh)] overflow-y-auto px-4 pt-3">
					<div class="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
						{toolName === "probe" ? "Probe" : toolName === "recall" ? "Recall" : kind === "quiz" ? (qd.questionType === "predict" ? "Prediction" : "Check") : kind === "explain" ? "Explain" : "Question"}
						{qd.mode === "multi-select" ? " · select all that apply" : ""}
					</div>
					<div class="mb-3 font-medium"><Markdown text={qd.question} tool /></div>
					{#if qd.context}
						<div class="mb-3 text-sm text-muted-foreground"><Markdown text={qd.context} tool /></div>
					{/if}

					{#if qd.mode !== "text"}
						<div class="flex flex-col gap-2 pb-2" role={qd.mode === "multi-select" ? "group" : "radiogroup"}>
							{#each qd.options as opt, i (opt.value)}
								{@const isSel = sel.selected.has(i)}
								<button
									type="button"
									role={qd.mode === "multi-select" ? "checkbox" : "radio"}
									aria-checked={isSel}
									data-kbdrow={i}
									onclick={() => toggle(i)}
									class={cn(
										"flex items-start gap-3 rounded-lg border px-3 py-2 text-left text-sm outline-none transition-colors",
										isSel ? "border-primary bg-accent" : "hover:bg-accent/50",
										i === kbdIdx && !isSel && "ring-1 ring-border bg-accent/40",
									)}
								>
									<span
										class={cn(
											"mt-0.5 flex size-4 shrink-0 items-center justify-center border",
											qd.mode === "multi-select" ? "rounded-sm" : "rounded-full",
											isSel ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
										)}
									>
										{#if isSel}
											<span class={qd.mode === "multi-select" ? "text-base leading-none" : "size-1.5 rounded-full bg-current"}>{qd.mode === "multi-select" ? "✓" : ""}</span>
										{/if}
									</span>
									<span>
										<Markdown text={opt.label} tool />
										{#if kind !== "quiz" && opt.description}
											<Markdown class="lh-prose block text-xs text-muted-foreground" text={opt.description} tool />
										{/if}
									</span>
								</button>
							{/each}

							{#if kind === "quiz"}
								<button
									type="button"
									onclick={() => (sel = { ...sel, selected: new Set(), otherSelected: false, dontKnow: !sel.dontKnow })}
									data-kbdrow={optionCount}
									aria-pressed={sel.dontKnow}
									class={cn(
										"flex items-start gap-3 rounded-lg border border-dashed px-3 py-2 text-left text-sm outline-none transition-colors",
										sel.dontKnow ? "border-primary text-foreground" : "text-muted-foreground",
										kbdIdx === optionCount && !sel.dontKnow && "ring-1 ring-border bg-accent/40",
									)}
								>
									<span class={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", sel.dontKnow ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40")}>
										{#if sel.dontKnow}<span class="size-1.5 rounded-full bg-current"></span>{/if}
									</span>
									<span>I don't know</span>
								</button>
							{/if}

							{#if kind === "ask"}
								<div
									role={qd.mode === "multi-select" ? "checkbox" : "radio"}
									aria-checked={sel.otherSelected}
									data-testid="other-option"
									data-kbdrow={optionCount}
									onclick={selectOther}
									class={cn(
										"flex items-start gap-3 rounded-lg border px-3 py-2 text-left text-sm outline-none transition-colors",
										sel.otherSelected ? "border-primary bg-accent" : "border-dashed hover:bg-accent/50",
										kbdIdx === optionCount && !sel.otherSelected && "ring-1 ring-border bg-accent/40",
									)}
								>
									<span class={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center border", qd.mode === "multi-select" ? "rounded-sm" : "rounded-full", sel.otherSelected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40")}>
										{#if sel.otherSelected}<span class={qd.mode === "multi-select" ? "text-base leading-none" : "size-1.5 rounded-full bg-current"}>{qd.mode === "multi-select" ? "✓" : ""}</span>{/if}
									</span>
									<input
										bind:this={otherEl}
										value={other}
										oninput={(event) => {
											other = (event.currentTarget as HTMLInputElement).value;
											sel = sel.otherSelected ? sel : toggleOther(selectMode, sel);
										}}
										onkeydown={(event) => {
											if (event.key === "Escape") {
												event.preventDefault();
												event.stopPropagation();
												(event.currentTarget as HTMLInputElement).blur();
												kbdIdx = optionCount;
											}
											if (event.key === "Enter") {
												event.preventDefault();
												submit();
											}
										}}
										placeholder="Type your own answer…"
										class="lh-input w-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
										onclick={(event) => event.stopPropagation()}
									/>
								</div>
							{/if}
						</div>
					{/if}
				</div>

				{#if kind === "quiz"}
					<div class="border-t border-border/60 px-4 py-2.5">
						<div class="flex items-center gap-3">
							<span class={cn("shrink-0 text-xs font-medium uppercase tracking-wide", sel.dontKnow ? "text-muted-foreground/50" : "text-muted-foreground")}>Confidence</span>
							<div class={cn("relative h-4 min-w-0 flex-1", sel.dontKnow && "opacity-40")} data-testid="confidence-track">
								<div
									aria-hidden="true"
									data-testid="confidence-rail"
									class="pointer-events-none absolute top-1/2 left-2 right-2 h-1.5 -translate-y-1/2 rounded-full border border-border"
									style={confidenceRailStyle(CONFIDENCE_STOPS[confIdx]!)}
								></div>
								<input
									type="range"
									min={0}
									max={100}
									step={1}
									value={CONFIDENCE_STOPS[confIdx]}
									disabled={sel.dontKnow}
									aria-label="Confidence — the probability your selected answer is correct"
									aria-valuetext={`${CONFIDENCE_STOPS[confIdx]} percent`}
									title="The probability your selected answer is correct — 50% is a coin flip. Adjust with ←/→."
									data-testid="confidence-slider"
									oninput={(event) => {
										const value = Number((event.currentTarget as HTMLInputElement).value);
										let best = 0;
										for (let i = 1; i < CONFIDENCE_STOPS.length; i++) {
											if (Math.abs(CONFIDENCE_STOPS[i]! - value) < Math.abs(CONFIDENCE_STOPS[best]! - value)) best = i;
										}
										confIdx = best;
									}}
									style={`color:${CONFIDENCE_COLORS[confIdx]}`}
									class="absolute inset-0 h-4 w-full cursor-pointer appearance-none bg-transparent outline-none [&::-webkit-slider-runnable-track]:h-4 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-current [&::-moz-range-track]:h-4 [&::-moz-range-track]:bg-transparent [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-current"
								/>
							</div>
							<span data-testid="confidence-value" class={cn("w-9 shrink-0 text-right font-mono text-sm tabular-nums", sel.dontKnow && "text-muted-foreground/50")}>
								{sel.dontKnow ? "—" : `${CONFIDENCE_STOPS[confIdx]}%`}
							</span>
						</div>
					</div>
				{/if}

				<form class="border-t border-border/60 p-1.5" onsubmit={(event) => { event.preventDefault(); submit(); }}>
					<div
						data-testid={qd.mode === "text" ? "answer-field" : "thinking-field"}
						class="rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50"
					>
						<div class="px-2.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
							{qd.mode === "text" ? "Your answer" : "YOUR THINKING"}
						</div>
						{#if qd.mode === "text"}
							<textarea
								bind:this={prose}
								data-testid="prose-field"
								value={text}
								oninput={(event) => {
									answerRefValue = (event.currentTarget as HTMLTextAreaElement).value;
									text = answerRefValue;
								}}
								onkeydown={(event) => {
									if (event.key === "Escape" && onEscape) {
										event.preventDefault();
										event.stopPropagation();
										onEscape();
										return;
									}
									if (event.key === "Enter" && (event.metaKey || event.ctrlKey || !event.shiftKey)) {
										event.preventDefault();
										submit();
									}
								}}
								placeholder="Type your answer…"
								rows={1}
								class="field-sizing-content lh-input max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
							></textarea>
						{:else}
							<textarea
								bind:this={thinkingEl}
								data-testid="prose-field"
								value={thinking}
								oninput={(event) => {
									thinkingRefValue = (event.currentTarget as HTMLTextAreaElement).value;
									thinking = thinkingRefValue;
								}}
								onkeydown={(event) => {
									if (event.key === "Escape" && onEscape) {
										event.preventDefault();
										event.stopPropagation();
										onEscape();
										return;
									}
									if (event.key === "Enter" && (!event.shiftKey || event.metaKey || event.ctrlKey)) {
										event.preventDefault();
										submit();
									}
								}}
								placeholder="Why this answer? Whatever comes to mind."
								rows={1}
								class={cn(
									"field-sizing-content lh-input max-h-48 w-full resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground/70",
									phase === "teach" ? "min-h-[4.5rem]" : "min-h-10",
								)}
							></textarea>
						{/if}
						<CodeInput value={code} onChange={(value) => (code = value)} onSubmit={submit} {onEscape} onLeave={() => prose?.focus()} />
						<div class="flex items-center justify-between gap-2 p-1">
							<span aria-hidden="true" class="pl-1.5 text-xs text-muted-foreground">
								{compactionRunning ? "compacting session…" : "↵ submits · ⇧↵ newline"}
							</span>
							<button
								type="submit"
								disabled={!canSubmit || compactionRunning}
								class="ml-auto h-9 rounded-[6px] bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-40"
							>
								Submit answer
							</button>
						</div>
					</div>
				</form>
			</div>
		{/if}
	</div>
{/if}
