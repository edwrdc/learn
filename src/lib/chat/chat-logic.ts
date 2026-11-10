import { MODELS_NOT_CONFIGURED_CODE, PROVIDER_KEY_MISSING_CODE, type RefusalCode } from "@/src/settings/model";

type EscAbortTarget = "question" | "problem" | "turn" | null;

/** What an unclaimed Escape aborts. Overlays (mermaid, plan, setup) never
 *  get here: their dismissLayer claims the Escape first. */
export function escAbortTarget(state: { abortAsk: boolean; pending: boolean; problem: boolean; busy: boolean }): EscAbortTarget {
	if (state.abortAsk) return null;
	if (state.pending) return "question";
	if (state.problem) return "problem";
	if (state.busy) return "turn";
	return null;
}

export function enterAction(state: { busy: boolean; canSend: boolean; nextProblem?: boolean }): "send" | "stop" | "next" | "none" {
	if (state.busy) return state.canSend ? "send" : "stop";
	if (state.canSend) return "send";
	if (state.nextProblem) return "next";
	return "none";
}

export function initialPromptOwed(messages: readonly { role: string }[], prompt: string | undefined): boolean {
	if (!prompt) return false;
	return !messages.some((m) => m.role === "user" || m.role === "assistant");
}

/** A refused turn: the transport throws the 503 body verbatim as the error
 *  text, so the envelope's code is read back out of it. */
export function parseRefusal(message: string | undefined): RefusalCode | "model_unavailable" | null {
	if (!message) return null;
	let body: unknown;
	try {
		body = JSON.parse(message);
	} catch {
		return null;
	}
	const code = (body as { code?: unknown } | null)?.code;
	switch (code) {
		case MODELS_NOT_CONFIGURED_CODE:
		case PROVIDER_KEY_MISSING_CODE:
		case "model_unavailable":
			return code;
		default:
			return null;
	}
}
