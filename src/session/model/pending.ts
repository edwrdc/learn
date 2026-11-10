/**
 * These scans read VIEW messages (view.ts LhViewMessage — the client's
 * grouped transcript); a tool part is structural: `tool-` prefix +
 * toolCallId. The server-side record scan (danglingQuestionOf over native
 * LhMessage[]) lives in transcript.ts.
 */
import { QUESTION_TOOLS } from "../../tools/model/index.ts";

interface UIMessage {
	role?: string;
	parts: Array<Record<string, unknown> & { type: string }>;
}

function isToolUIPart(part: UIMessage["parts"][number]): boolean {
	return part.type.startsWith("tool-") && typeof part.toolCallId === "string";
}

/**
 * The pending-question gate: an unanswered QUESTION tool part (quiz/ask)
 * blocks the composer — one question at a time, mirroring the teacher's
 * prompt contract. Derived client state; the server enforces nothing.
 *
 * Scan order: MESSAGES newest-first (a later turn's live question supersedes
 * an older dangling one), but PARTS forward within a message — the model's
 * FIRST unanswered question is the dock subject. Parallel question calls
 * (pi executes them in one batch) are thus answered in the same order they
 * were asked, saved, and rendered as cards.
 *
 * Job tool parts (research/demo/visual) never pend client-side — the async
 * protocol resolves them server-side with an immediate ack, so job tools
 * are NOT returned here.
 */
interface PendingToolCall {
	toolCallId: string;
	tool: string;
	/** Tool input (quiz/ask args) — lets the composer pick note vs answer mode. */
	input: unknown;
}

function findPending(messages: UIMessage[], names: readonly string[]): PendingToolCall | null {
	for (let m = messages.length - 1; m >= 0; m--) {
		const msg = messages[m]!;
		for (let p = 0; p < msg.parts.length; p++) {
			const part = msg.parts[p]!;
			if (isToolUIPart(part) && part.state === "input-available") {
				const tool = part.type.slice("tool-".length);
				if (names.includes(tool)) {
					return { toolCallId: part.toolCallId as string, tool, input: part.input };
				}
			}
		}
	}
	return null;
}

export function findPendingToolCall(messages: UIMessage[]): PendingToolCall | null {
	return findPending(messages, QUESTION_TOOLS);
}

