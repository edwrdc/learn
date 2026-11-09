/** The bare teach question set the protocol suites drive: quiz with the
 *  shared authoring refinement (an invalid input returns an isError result
 *  the model retries on) but no per-session nodeId check, plus ask. */
import type { AppTool } from "../src/tools/index.ts";
import { invalidInputResult, questionResult } from "../src/tools/index.ts";
import { askUserQuestionTool } from "../src/session/tools/registry.ts";
import { quizInputObject, quizInputProblems } from "../src/session/model/questions.ts";
import { newMessageId, type LhMessage } from "../src/session/model/transcript.ts";

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
	return { quiz, ask_user_question: askUserQuestionTool };
}

/** The result a posed question commits (details null): an answer replaces
 *  it. Seeds that pose a question need it, like a real turn. */
export function posedPlaceholder(toolCallId: string, toolName = "quiz"): LhMessage {
	return {
		id: newMessageId(),
		role: "toolResult",
		toolCallId,
		toolName,
		content: questionResult().content,
		details: null,
		isError: false,
		timestamp: Date.now(),
	} as LhMessage;
}
