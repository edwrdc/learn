/** Session Find's DOM layer: CSS Custom Highlight registration, teardown,
 *  and the foreground-layer gate. */
export const SESSION_FIND_HIGHLIGHT = "lh-session-find";
export const SESSION_FIND_ACTIVE_HIGHLIGHT = "lh-session-find-active";
export const FIND_STYLE_ID = "lh-session-find-style";

export function injectFindStyles(): void {
	if (document.getElementById(FIND_STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = FIND_STYLE_ID;
	style.textContent = `
::highlight(${SESSION_FIND_HIGHLIGHT}) { background-color: color-mix(in oklab, var(--primary) 25%, transparent); }
::highlight(${SESSION_FIND_ACTIVE_HIGHLIGHT}) { background-color: var(--primary); color: var(--primary-foreground); }`;
	document.head.appendChild(style);
}

export function clearSessionFindHighlights(): void {
	if (typeof CSS === "undefined") return;
	CSS.highlights?.delete(SESSION_FIND_HIGHLIGHT);
	CSS.highlights?.delete(SESSION_FIND_ACTIVE_HIGHLIGHT);
}

export function sessionFindHasForegroundLayer(doc: Document): boolean {
	return Array.from(
		doc.querySelectorAll(
			'[data-lh-menu], [data-radix-popper-content-wrapper], [role="menu"], [role="dialog"], [data-testid="cheat-sheet"]',
		),
	).some((element) => {
		if (element.getAttribute("data-state") === "closed" || element.hasAttribute("hidden")) return false;
		const view = doc.defaultView;
		if (typeof view?.getComputedStyle !== "function") return true;
		const style = view.getComputedStyle(element);
		return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
	});
}
