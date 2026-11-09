/** Window-level Enter submits from anywhere (typing surfaces and overlay
 *  buttons keep their own lane), plus the shared "focused button keeps
 *  native Enter" rule. */
import { isTypingSurface } from "@/src/settings/model";

const OVERLAY_ROOTS = '[data-lh-menu], [data-radix-popper-content-wrapper], [role="menu"], [role="dialog"]';

export function buttonKeepsNativeEnter(el: HTMLElement): boolean {
	try {
		if (el.matches(":focus-visible")) return true;
	} catch {
		/* selector engine without the pseudo (tests) */
	}
	return !!el.closest(OVERLAY_ROOTS);
}

export function enterSubmits(submit: () => void) {
	return (node: HTMLElement) => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Enter") return;
			if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
			if (isTypingSurface(event)) return;
			const target = event.target as HTMLElement | null;
			if (target?.tagName === "BUTTON" && buttonKeepsNativeEnter(target)) return;
			event.preventDefault();
			submit();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	};
}

export function blurAfterPointerClick(event: MouseEvent): void {
	if (event.detail === 0) return;
	(event.currentTarget as HTMLElement | null)?.blur();
}
