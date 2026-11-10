import { toolInfo, type QuestionKind } from "@/src/tools/model";

/** A question card's header label: the tool's catalog title (Probe,
 *  Recall), else the kind's own (a predict quiz reads "Prediction"). */
export function questionLabel(tool: string | undefined, kind: QuestionKind, questionType: string | undefined): string {
	const title = tool === undefined ? undefined : toolInfo(tool)?.title;
	if (title) return title;
	if (kind === "quiz") return questionType === "predict" ? "Prediction" : "Check";
	return kind === "explain" ? "Explain" : "Question";
}
