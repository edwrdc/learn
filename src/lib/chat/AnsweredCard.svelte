<script lang="ts">
	import { answerForPresentation, parseAskInput, parseQuizInput, type QuestionAnswerData } from "@/src/session/model";
	import { toolInfo } from "@/src/tools/model";
	import Markdown from "$lib/markdown/Markdown.svelte";
	import ConfidenceRail from "./ConfidenceRail.svelte";
	import GlyphMark from "./GlyphMark.svelte";
	import ThinkingBlock from "./ThinkingBlock.svelte";

	let { answer: savedAnswer, input }: { answer: QuestionAnswerData; input?: unknown } = $props();

	// Page/record data can arrive wrapped in Svelte state proxies; core's
	// zod parsing clones its input with structuredClone. Normalize the JSON
	// wire shape at this boundary (the schema rejects functions anyway).
	const plainAnswer = $derived(JSON.parse(JSON.stringify(savedAnswer)));
	const plainInput = $derived(input === undefined ? undefined : JSON.parse(JSON.stringify(input)));
	const answer = $derived(answerForPresentation(plainAnswer, plainInput));
	const askInput = $derived(answer.kind === "ask" ? parseAskInput(plainInput) : undefined);
	const parsedDetails = $derived(askInput?.details ?? (answer.kind === "quiz" ? parseQuizInput(plainInput)?.details : undefined));
	const descByIndex = $derived(new Map((askInput?.options ?? []).map((o, i) => [i + 1, o.description])));
	const selectedIdx = $derived(new Set(answer.answers.map((a) => a.index)));
	const correctIdx = $derived(new Set(answer.correctIndices ?? []));
	const isQuiz = $derived(answer.kind === "quiz");
	const isExplain = $derived(answer.kind === "explain");
	let whyOpen = $state(false);
</script>

{#if answer.dismissed}
	<div class="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
		<span class="font-medium">{answer.questionText}</span> — skipped
	</div>
{:else}
	{#if answer.readingThinking}
		<ThinkingBlock testId="reading-thinking-block" label="YOUR THINKING" text={answer.readingThinking} defaultOpen />
	{/if}
	<div class="rounded-xl border bg-card p-4 text-card-foreground [&>*:last-child]:mb-0" data-testid="answered-card">
		<div class="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
			{toolInfo(answer.tool ?? "")?.title ?? (isQuiz ? (answer.questionType === "predict" ? "Prediction" : "Check") : isExplain ? "Explain" : "Question")}
			{#if isQuiz}
				{#if answer.dontKnow}
					<span class="rounded bg-muted px-1.5 py-0.5">didn't know</span>
				{:else if answer.correct}
					<span class="rounded bg-green-500/15 px-1.5 py-0.5 text-green-500">correct</span>
				{:else}
					<span class="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">incorrect</span>
				{/if}
			{/if}
		</div>
		<div class="mb-3 font-medium"><Markdown text={answer.questionText} tool /></div>
		{#if parsedDetails}
			<div class="mb-3 text-sm text-muted-foreground"><Markdown text={parsedDetails} tool /></div>
		{/if}

		{#if (answer.options?.length ?? 0) > 0 || answer.other}
			<div class="flex flex-col gap-1.5 text-sm">
				{#each answer.options ?? [] as opt (opt.index)}
					{@const selected = selectedIdx.has(opt.index)}
					{@const key = isQuiz && correctIdx.has(opt.index)}
					<div
						class="flex items-center gap-2 rounded-lg border px-3 py-1.5 {selected && key
							? 'border-green-500/60 bg-green-500/10'
							: selected && !key && isQuiz
								? 'border-red-500/60 bg-red-500/10'
								: selected && !isQuiz
									? 'border-primary bg-accent'
									: !selected && key
										? 'border-green-500/40'
										: ''}"
					>
						{#if isQuiz}
							<span
								aria-hidden="true"
								class="flex shrink-0 items-center {selected && key ? 'text-green-500' : selected && !key ? 'text-red-500' : !selected && key ? 'text-green-500' : ''}"
							>
								{#if key || selected}<GlyphMark kind={key ? "check" : "x"} class="size-3.5" />{/if}
							</span>
						{/if}
						<span class={!selected ? "text-muted-foreground" : ""}>
							<Markdown text={opt.label} tool />
							{#if descByIndex.get(opt.index)}
								<Markdown class="lh-prose block text-xs text-muted-foreground" text={descByIndex.get(opt.index)!} tool />
							{/if}
						</span>
					</div>
				{/each}
				{#if answer.other}
					<div data-testid="answered-other" class="flex items-center gap-2 rounded-lg border border-primary bg-accent px-3 py-1.5">
						<span>“{answer.other}”</span>
					</div>
				{/if}
			</div>
		{/if}

		{#if answer.text}
			<div class="mt-2"><Markdown text={answer.text} /></div>
		{/if}

		{#if isQuiz && answer.confidence != null}
			<div class="mt-3 flex items-center gap-3" data-testid="answered-confidence">
				<ConfidenceRail value={answer.confidence} class="min-w-0 flex-1" />
				<span class="w-9 shrink-0 text-right font-mono text-sm tabular-nums text-muted-foreground">{answer.confidence}%</span>
			</div>
		{/if}
		{#if answer.dontKnow && isQuiz}
			<div class="mt-2 text-sm text-muted-foreground">Answered “I don't know”.</div>
		{/if}

		{#if answer.thinking ?? answer.note}
			<ThinkingBlock testId="your-thinking" label="YOUR THINKING" text={answer.thinking ?? answer.note ?? ""} inCard />
		{/if}

		{#if isQuiz && answer.explanation}
			<div class="mt-2" data-testid="tucked-explanation">
				<button
					type="button"
					onclick={() => (whyOpen = !whyOpen)}
					class="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
				>
					{whyOpen ? "Hide why" : "Why"}
				</button>
				{#if whyOpen}
					<div class="mt-1.5 rounded-lg bg-muted py-2 text-sm text-foreground/50">
						<span class="font-medium text-muted-foreground">Why: </span>
						<Markdown class="inline [&>p:first-child]:inline [&>p:first-child]:m-0" text={answer.explanation} tool />
					</div>
				{/if}
			</div>
		{/if}

		{#if isExplain && answer.committed}
			<div class="mt-3 rounded-lg bg-muted py-2 text-sm text-muted-foreground">
				<span class="font-medium text-foreground">The answer: </span>
				<Markdown class="inline [&>p:first-child]:inline [&>p:first-child]:m-0" text={answer.committed} tool />
			</div>
		{/if}
	</div>
{/if}
