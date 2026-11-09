/** Every model-callable tool, listed once. Registries, the durable adapter,
 *  settings toggles and the UI read their per-tool facts from here. */

export type QuestionKind = "quiz" | "explain" | "ask";

export interface ToolInfo {
	kind: "question" | "practice" | "plan" | "job" | "side" | "submit";
	/** It never mutates app state, so a crash mid-call may rerun it. */
	replaySafe?: true;
	/** The learner answers it: its result is a placeholder until then. */
	answeredByLearner?: true;
	/** The question dock's kind (question tools). */
	question?: QuestionKind;
	/** The dock and answer header when it differs from the kind's own. */
	title?: string;
	/** The live card label while the tool runs. */
	activity?: string;
	/** The sub-agent's name (job tools). */
	agent?: string;
}

export const TOOLS = {
	quiz: { kind: "question", replaySafe: true, answeredByLearner: true, question: "quiz" },
	explain: { kind: "question", replaySafe: true, answeredByLearner: true, question: "explain" },
	probe: { kind: "question", replaySafe: true, answeredByLearner: true, question: "quiz", title: "Probe" },
	recall: { kind: "question", replaySafe: true, answeredByLearner: true, question: "explain", title: "Recall" },
	ask_user_question: { kind: "question", replaySafe: true, answeredByLearner: true, question: "ask" },
	problem: { kind: "practice", replaySafe: true, answeredByLearner: true },
	conclude: { kind: "practice", replaySafe: true },
	plan_init: { kind: "plan", activity: "Drawing up the plan…" },
	probe_done: { kind: "plan", activity: "Concluding the assessment…" },
	research: { kind: "job", activity: "Dispatching research…", agent: "Researcher" },
	demo: { kind: "job", activity: "Building a demo…", agent: "Demo builder" },
	visual: { kind: "job", activity: "Making a visual…", agent: "Figure maker" },
	pdf: { kind: "job", activity: "Reading a PDF…", agent: "PDF reader" },
	read: { kind: "side", activity: "Reading a file…" },
	ls: { kind: "side", activity: "Listing a directory…" },
	find: { kind: "side", activity: "Finding files…" },
	grep: { kind: "side", activity: "Searching file contents…" },
	list_sessions: { kind: "side" },
	list_propositions: { kind: "side" },
	web_search: { kind: "side" },
	web_fetch: { kind: "side" },
	web_fetch_pdf: { kind: "side" },
	pdf_info: { kind: "side" },
	pdf_extract: { kind: "side" },
	pdf_search: { kind: "side" },
	pdf_render: { kind: "side" },
	write_demo: { kind: "side" },
	run_demo: { kind: "side" },
	write_svg: { kind: "side" },
	edit_svg: { kind: "side" },
	render_svg: { kind: "side" },
	submit_findings: { kind: "submit" },
	submit_review: { kind: "submit" },
} as const satisfies Record<string, ToolInfo>;

export type ToolName = keyof typeof TOOLS;

type NamesOf<K extends ToolInfo["kind"]> = { [N in ToolName]: (typeof TOOLS)[N]["kind"] extends K ? N : never }[ToolName];

export type QuestionToolName = NamesOf<"question">;
/** A job tool's name is its job kind. */
export type JobKind = NamesOf<"job">;

function namesOf<K extends ToolInfo["kind"]>(kind: K): NamesOf<K>[] {
	return (Object.keys(TOOLS) as ToolName[]).filter((name) => TOOLS[name].kind === kind) as NamesOf<K>[];
}

/** The tools that render in the question dock and gate the composer. */
export const QUESTION_TOOLS: readonly QuestionToolName[] = namesOf("question");
/** The sub-agent job kinds; these are also the only toggleable tools. */
export const JOB_KINDS: readonly JobKind[] = namesOf("job");

export function toolInfo(name: string): ToolInfo | undefined {
	return Object.hasOwn(TOOLS, name) ? (TOOLS as Record<string, ToolInfo>)[name] : undefined;
}

export function isQuestionTool(name: string): name is QuestionToolName {
	return toolInfo(name)?.kind === "question";
}

/** The dock kind of a question tool (anything else asks). */
export function toolQuestionKind(name: string): QuestionKind {
	return toolInfo(name)?.question ?? "ask";
}

/** The live card label for one running tool. */
export function toolActivityLabel(name: string): string {
	if (isQuestionTool(name)) return "Writing a question…";
	return toolInfo(name)?.activity ?? "Working…";
}

/** The sub-agent's name for a job kind. */
export function jobAgentLabel(kind: JobKind): string {
	return TOOLS[kind].agent;
}

// ─── settings toggles ─────────────────────────────────────────────────────────

/** Settings `agent.tools`: absent = on. Only job tools can be switched off;
 *  `explain: true` is not a toggle but the quiz-mechanics switch. */
export type EnabledTools = Partial<Record<string, boolean>>;

/** The keys a settings write accepts in `agent.tools`. */
export const WRITABLE_TOOL_KEYS = [...JOB_KINDS, "explain"] as const;

/** Free recall (explain/recall) instead of multiple choice (quiz/probe). */
export function quizMechanics(enabled: EnabledTools | undefined): "free" | "choice" {
	return enabled?.explain === true ? "free" : "choice";
}

/** Drop the job tools the settings switched off; every other tool stays. */
export function enabledTools<T>(tools: Record<string, T>, enabled: EnabledTools | undefined): Record<string, T> {
	if (!enabled) return tools;
	return Object.fromEntries(
		Object.entries(tools).filter(([name]) => !(toolInfo(name)?.kind === "job" && enabled[name] === false)),
	);
}
