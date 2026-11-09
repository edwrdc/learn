import type { ModelSlotName } from "@/src/settings/model";

type EscAbortTarget = "mermaid" | "plan" | "setup" | "question" | "problem" | "turn" | null;

export function escAbortTarget(state: {
	abortAsk: boolean;
	mermaidFocus: boolean;
	planOpen: boolean;
	setupOpen: boolean;
	pending: boolean;
	problem: boolean;
	busy: boolean;
}): EscAbortTarget {
	if (state.abortAsk) return null;
	if (state.mermaidFocus) return "mermaid";
	if (state.planOpen) return "plan";
	if (state.setupOpen) return "setup";
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

export function parseModelsRefusal(message: string | undefined): ModelSlotName[] | null {
	if (!message) return null;
	try {
		const body = JSON.parse(message) as { code?: unknown; missing?: unknown };
		if (body.code === "models_not_configured" && Array.isArray(body.missing) && body.missing.every((s) => typeof s === "string")) {
			return body.missing as ModelSlotName[];
		}
		return null;
	} catch {
		return null;
	}
}

export function parseProviderKeyRefusal(message: string | undefined): boolean {
	if (!message) return false;
	try {
		const body = JSON.parse(message) as { code?: unknown; error?: unknown };
		return body.code === "provider_key_missing" && typeof body.error === "string" && body.error.endsWith("add one in Settings → Keys");
	} catch {
		return false;
	}
}

export function parseModelUnavailableRefusal(message: string | undefined): { code: "model_unavailable"; error: string } | null {
	if (!message) return null;
	try {
		const body = JSON.parse(message) as { code?: unknown; error?: unknown };
		if (body.code === "model_unavailable" && typeof body.error === "string") {
			return { code: "model_unavailable", error: body.error };
		}
		return null;
	} catch {
		return null;
	}
}
