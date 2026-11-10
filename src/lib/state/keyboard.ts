/** The single window-level keydown owner: Tab is dead, Shift+Tab
 *  cycles thinking, an unclaimed Escape aborts the turn, and
 *  registry actions dispatch or navigate. */
import { goto } from "$app/navigation";
import { actionForBinding, eventBinding, isTypingSurface } from "@/src/settings/model";
import { emitKeyAction } from "$lib/events";
import { cheatSheet, settingsDialog } from "./dialogs.svelte";

export function initKeyboard(): () => void {
	if (typeof window === "undefined") return () => {};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Tab") {
			event.preventDefault();
			if (event.shiftKey) emitKeyAction("cycle-thinking");
			return;
		}
		if (event.key === "Escape") {
			// Open layers (dialogs, menus, a running dictation) took their
			// Escape already; what reaches here aborts the turn.
			emitKeyAction("abort-turn");
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
				emitKeyAction(action);
				break;
			default:
				emitKeyAction(action);
		}
	};
	window.addEventListener("keydown", onKeyDown);
	return () => window.removeEventListener("keydown", onKeyDown);
}
