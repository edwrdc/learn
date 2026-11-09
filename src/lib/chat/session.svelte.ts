/** Svelte adapter over the portable SessionModel (src/lib/chat/session-core.ts).
 *  The model owns the state machine; this class mirrors its state into a
 *  rune so components re-render on change. */
import { SessionModel, type SessionState } from "./session-core.ts";
import type { ChatInput, LhMessage, QuestionAnswerData } from "@/src/session/model";

export class SessionView {
	readonly model: SessionModel;
	state = $state.raw<SessionState>({
		messages: [],
		nativeMessages: [],
		status: "ready",
		error: null,
		steerQueue: [],
	});

	constructor(opts: { chatId: string; initialMessages: LhMessage[]; onChange?: () => void }) {
		this.model = new SessionModel({
			chatId: opts.chatId,
			// The page data arrives as a Svelte state proxy; core's tool-input
			// parsing uses structuredClone, which cannot clone a proxy. The
			// record is plain JSON by contract, so snapshot it at the boundary.
			initialMessages: JSON.parse(JSON.stringify(opts.initialMessages)) as LhMessage[],
			onChange: () => {
				this.sync();
				opts.onChange?.();
			},
		});
		this.sync();
	}

	private sync(): void {
		this.state = this.model.getState();
	}

	readonly send = (input: ChatInput): void => void this.model.send(input);
	readonly steer = (text: string): void => void this.model.steer(text);
	readonly submitAnswer = (tool: string, toolCallId: string, output: QuestionAnswerData): void =>
		void this.model.submitAnswer(tool, toolCallId, output);
	readonly dismissQuestion = (toolCallId: string, answer: QuestionAnswerData): void =>
		void this.model.dismissQuestion(toolCallId, answer);
	readonly dismissProblem = (problemCallId: string): void => void this.model.dismissProblem(problemCallId);
	readonly setMessages = (record: LhMessage[]): void => this.model.setMessages(record);
	readonly adoptRecord = (record: LhMessage[]): void => this.model.adoptRecord(record);
	readonly stop = (): void => this.model.stop();
	readonly clearError = (): void => this.model.clearError();
	readonly resumeStream = (refetch = true): void => void this.model.resumeStream(refetch);
	readonly setReattachSettled = (fn: () => void): void => this.model.setReattachSettled(fn);
	readonly isReady = (): boolean => this.model.status === "ready";
}
