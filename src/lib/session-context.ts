/** What a chat page offers the cards and markdown rendered inside it. Both
 *  are optional: the same components render outside a chat too. */

/** Per-session actions the artifact cards reach. */
export const CHAT_ACTIONS = Symbol("lh:chat-actions");

export interface ChatActions {
	chatId: string;
	sendText: (text: string) => void;
	openSetup: () => void;
}

/** The session's focus overlay for diagrams and figures. */
export const SESSION_MERMAID = Symbol("lh:session-mermaid");

export interface SessionMermaidApi {
	openMermaid: (chart: string) => void;
	openFigure: (svg: string, inverted: boolean) => void;
}
