/** Per-session actions the artifact cards reach. */
export const CHAT_ACTIONS = Symbol("lh:chat-actions");

export interface ChatActions {
	chatId: string;
	syncFromServer: () => Promise<void>;
	sendText: (text: string) => void;
	openSetup: () => void;
}
