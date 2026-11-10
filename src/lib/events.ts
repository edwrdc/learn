/** The page's own events between surfaces (window CustomEvents), typed in
 *  one map. Server pushes ride the SSE hub instead (state/server-events). */
import type { KeyAction } from "@/src/settings/model";

/** The settings sections a save announces ("keys" covers keys and the
 *  custom endpoint's key). */
export type SavedSection = "keys" | "agent" | "models" | "appearance" | "graph" | "graphRender" | "compaction";

interface AppEvents {
	"chat-renamed": { id: string; title: string };
	/** A chat view's local turn started or settled. */
	"turn-state": { id: string; running: boolean };
	/** The graph changed under every view (a deletion landed). */
	"graph-revision": { graphRevision: number };
	"settings-saved": { section: SavedSection };
}

export function emitAppEvent<K extends keyof AppEvents>(type: K, detail: AppEvents[K]): void {
	window.dispatchEvent(new CustomEvent(`lh:${type}`, { detail }));
}

export function onAppEvent<K extends keyof AppEvents>(type: K, handler: (detail: AppEvents[K]) => void): () => void {
	if (typeof window === "undefined") return () => {};
	const listener = (event: Event) => handler((event as CustomEvent<AppEvents[K]>).detail);
	window.addEventListener(`lh:${type}`, listener);
	return () => window.removeEventListener(`lh:${type}`, listener);
}

/** A registry shortcut, or Escape's fallback when no layer claimed it. */
type KeyEvent = KeyAction | "abort-turn";

/** The one spelling of a key event's name, shared by the dispatcher and
 *  every listener. */
export function kbdEventForAction(action: KeyEvent): string {
	return `lh:kbd-${action}`;
}

export function emitKeyAction(action: KeyEvent): void {
	window.dispatchEvent(new CustomEvent(kbdEventForAction(action)));
}

export function onKeyAction(action: KeyEvent, handler: () => void): () => void {
	if (typeof window === "undefined") return () => {};
	window.addEventListener(kbdEventForAction(action), handler);
	return () => window.removeEventListener(kbdEventForAction(action), handler);
}
