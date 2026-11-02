/** Scroll only the session's own containers, then the transcript, and flash
 *  the anchor (the source-message arrival contract). */
export function scrollSessionTarget(
	target: Range | HTMLElement,
	scope: HTMLElement,
	main: HTMLElement | null,
	stopScroll: () => void,
): void {
	const node = "startContainer" in target ? target.startContainer : target;
	if (main?.contains(node)) stopScroll();
	for (let element = (node as Node).parentElement; element && scope.contains(element); element = element.parentElement) {
		const style = typeof window !== "undefined" ? window.getComputedStyle(element) : null;
		if (
			element !== main &&
			(!style || !/(auto|scroll)/.test(style.overflowY) || element.scrollHeight <= element.clientHeight)
		)
			continue;
		const rect = (target as Range).getBoundingClientRect?.() ?? (target as HTMLElement).getBoundingClientRect();
		const container = element.getBoundingClientRect();
		element.scrollTo({ top: element.scrollTop + rect.top - container.top - 16, behavior: "instant" });
	}
}
