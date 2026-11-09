/** The Electron shell: platform classes for chrome styling, and the zoom
 *  factor published as --lh-zoom so physical-size lengths can divide by it. */
export const IS_ELECTRON = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

export function initDesktop(): void {
	if (!IS_ELECTRON) return;
	document.documentElement.classList.add("lh-electron");
	document.documentElement.dataset.lhPlatform = window.lh?.platform ?? "";
	const setZoom = (factor: number) => document.documentElement.style.setProperty("--lh-zoom", String(factor));
	window.lh?.onZoom?.(setZoom);
	void window.lh?.getZoom?.().then(setZoom);
}
