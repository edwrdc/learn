/**
 * Prompt composition for the teaching roles, plus the bare question tool
 * set the protocol suites drive.
 *
 * The durable runtime builds each turn's tools and prompt itself
 * (src/server/durable-registry.ts). This module is the composition law both
 * consumers share: system-prompt.md (the shared base: agent, voice,
 * philosophy, accuracy) + every numeric-prefix fragment in the role's
 * directory (src/agent/prompts/prober/, teacher/, or practice/), in sorted
 * filename order, then the shared/ fragments as a trailing appendix
 * (question tools, learner files, formatting). Joined with `---`
 * separators.
 *
 * ONLY numeric-prefix files load — the loader enforces the convention, so
 * non-fragment documentation (README.md, …) can live in the directories
 * without ever leaking into the model's prompt.
 */

import { invalidInputResult, questionResult } from "./tool-execute.ts";
import { askUserQuestionTool } from "./tools.ts";
import { healToolRecord } from "./tools/heal.ts";
import { quizInputObject, quizInputProblems } from "../core/question-core.ts";
import { effectivePromptSegments } from "./prompt-segments.ts";
import type { AppTool } from "./tool-adapter.ts";

/** Which agent's prompt directory to compose. Practice (2026-10-04)
 *  composes ONLY its own directory — see prompt-segments.ts. */
export type AgentKind = "prober" | "teacher" | "practice";

/** Compose one role's instructions. Composition is delegated to the store
 *  module's effectivePromptSegments — one canonical segment-discovery rule
 *  (its listSourceSegments mirrors the loader's, shared/ included) — so
 *  per-segment OVERRIDES ride the same path: a segment whose switch is ON
 *  and whose override file exists composes the override text instead of the
 *  source. `switches` is the settings record's agent.prompts map (absent key
 *  = off); a switches-less call composes pure source. Overrides are a
 *  static-file read through config paths, not request state. */
export function composeInstructions(kind: AgentKind, switches?: Record<string, boolean>): string {
	const segments = effectivePromptSegments(kind, switches ?? {});
	return segments
		.map((s) => (s.enabled ? s.overrideText! : s.sourceText))
		.map((t) => t.trim())
		.filter(Boolean)
		.join("\n\n---\n\n");
}

/** The bare teach question set (the protocol suites' fixture): quiz with the
 *  shared authoring refinement (quizInputProblems, run in execute — returns
 *  an invalidInputResult isError result the model retries on) but NO
 *  per-session nodeId check (no record to read), plus ask. */
export function bareQuestionTools(): Record<string, AppTool<any>> {
	const quiz: AppTool<typeof quizInputObject> = {
		name: "quiz",
		label: "quiz",
		description: "Ask the learner a graded question.",
		parameters: quizInputObject,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems = quizInputProblems(input);
			if (problems.length > 0) return invalidInputResult("quiz", problems);
			return questionResult();
		},
	};
	return healToolRecord({
		quiz,
		ask_user_question: askUserQuestionTool,
	});
}
