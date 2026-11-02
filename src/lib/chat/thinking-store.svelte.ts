/** The ⌘T store: an explicit "all user thinking open" beats each row's own
 *  default until toggled again. */
export const userThinking = $state<{ value: boolean | null }>({ value: null });

export function currentUserThinkingOpen(): boolean {
	return userThinking.value ?? true;
}

export function setAllUserThinkingOpen(open: boolean): void {
	userThinking.value = open;
}

export function toggleUserThinking(): void {
	setAllUserThinkingOpen(!currentUserThinkingOpen());
}
