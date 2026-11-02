/** The single window-level keydown owner: Tab is dead, Shift+Tab
 *  cycles thinking, Escape falls back to dictation-cancel then abort, and
 *  registry actions dispatch or navigate. */
import { goto } from "$app/navigation";
import {
	actionForBinding,
	bindingForAction,
	eventBinding,
	isTypingSurface,
	kbdEventForAction,
} from "@/src/core";
import { cheatSheet, settingsDialog } from "./dialogs.svelte";
import { cancelDictation, dictationActive } from "$lib/chat/dictation.svelte";

export function initKeyboard(): () => void {
	if (typeof window === "undefined") return () => {};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Tab") {
			event.preventDefault();
			if (event.shiftKey) window.dispatchEvent(new CustomEvent("lh:kbd-cycle-thinking"));
			else if (!event.metaKey && !event.ctrlKey && !event.altKey)
				window.dispatchEvent(new CustomEvent("lh:kbd-cycle-fields"));
			return;
		}
		if (event.key === "Escape") {
			if (cheatSheet.open) {
				cheatSheet.open = false;
				event.preventDefault();
				return;
			}
			// Settings is a surfaced layer: its own Esc closes it, and the
			// fallback must not also run the dictation/abort chain.
			if (settingsDialog.show) {
				event.preventDefault();
				event.stopPropagation();
				settingsDialog.close();
				return;
			}
			if (dictationActive()) {
				event.preventDefault();
				cancelDictation();
				return;
			}
			window.dispatchEvent(new CustomEvent("lh:kbd-abort-turn"));
			return;
		}
		const action = actionForBinding(eventBinding(event));
		if (!action) return;
		if (isTypingSurface(event) && !(event.metaKey || event.ctrlKey || event.altKey)) return;
		switch (action) {
			case "new-session":
				void goto("/chat/new");
				break;
			case "open-settings":
				settingsDialog.open();
				break;
			case "jump-graph":
				void goto("/");
				break;
			case "cheat-sheet":
				cheatSheet.open = true;
				break;
			case "find":
				event.preventDefault();
				window.dispatchEvent(new CustomEvent(kbdEventForAction(action)));
				break;
			default:
				window.dispatchEvent(new CustomEvent(kbdEventForAction(action)));
		}
	};
	window.addEventListener("keydown", onKeyDown);
	return () => window.removeEventListener("keydown", onKeyDown);
}

export function actionBinding(action: Parameters<typeof bindingForAction>[0]): string {
	return bindingForAction(action);
}
