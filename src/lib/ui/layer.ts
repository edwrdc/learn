/** Open layers (popovers, menus, dialogs), newest last. Escape closes only
 *  the newest one; a click outside a layer closes that layer. Call from an
 *  effect while the layer is open and return the cleanup. */

interface LayerOptions {
	/** Nodes that count as inside (the anchor, the popover body). */
	inside?: () => ReadonlyArray<Node | null | undefined>;
	/** Clicks inside a floating menu (MenuShell portals) count as inside. */
	menus?: boolean;
	/** Only clicks landing inside this selector close the layer (a menu in
	 *  a dialog ignores clicks on whatever the dialog's backdrop covers). */
	closeWithin?: string;
	/** Clicks never close it (dialogs dismiss through their backdrop). */
	clickOutside?: boolean;
	/** Handle Escape (and outside clicks) before the target's own handlers. */
	capture?: boolean;
	/** Any scroll closes it (a popover anchored to moving content). */
	closeOnScroll?: boolean;
}

interface Layer {
	close: () => void;
	capture: boolean;
}

const stack: Layer[] = [];

function onEscape(capturePhase: boolean) {
	return (event: KeyboardEvent) => {
		const top = stack.at(-1);
		if (event.key !== "Escape" || !top || top.capture !== capturePhase) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		top.close();
	};
}

let installed = false;
function install(): void {
	if (installed) return;
	installed = true;
	document.addEventListener("keydown", onEscape(true), true);
	document.addEventListener("keydown", onEscape(false));
}

/** Is any layer open (a dialog, menu, popover or running dictation)? */
export function hasOpenLayer(): boolean {
	return stack.length > 0;
}

export function dismissLayer(close: () => void, options: LayerOptions = {}): () => void {
	if (typeof document === "undefined") return () => {};
	install();
	const layer: Layer = { close, capture: options.capture ?? false };
	stack.push(layer);
	const onPointerDown = (event: PointerEvent) => {
		const target = event.target;
		if (!(target instanceof Node)) return;
		if (options.inside?.().some((node) => node?.contains(target))) return;
		const element = target instanceof Element ? target : target.parentElement;
		if (options.menus && element?.closest("[data-lh-menu]")) return;
		if (options.closeWithin && !element?.closest(options.closeWithin)) return;
		close();
	};
	const clicks = options.clickOutside ?? true;
	if (clicks) document.addEventListener("pointerdown", onPointerDown, options.capture);
	const onScroll = () => close();
	if (options.closeOnScroll) window.addEventListener("scroll", onScroll, { capture: true, passive: true });
	return () => {
		stack.splice(stack.indexOf(layer), 1);
		if (clicks) document.removeEventListener("pointerdown", onPointerDown, options.capture);
		if (options.closeOnScroll) window.removeEventListener("scroll", onScroll, { capture: true });
	};
}

/** Backdrop dismissal: a genuine click that both starts AND ends on the
 *  backdrop closes; a drag beginning inside the dialog never does. */
export function backdropDismiss(onDismiss: () => void) {
	return (node: HTMLElement) => {
		let press: { pointerId: number; released: boolean } | null = null;
		const down = (event: PointerEvent) => {
			press =
				event.isPrimary && event.button === 0 && event.target === node
					? { pointerId: event.pointerId, released: false }
					: null;
			if (press && node.hasPointerCapture?.(event.pointerId)) node.releasePointerCapture(event.pointerId);
		};
		const up = (event: PointerEvent) => {
			press =
				press && press.pointerId === event.pointerId && event.isPrimary && event.button === 0 && event.target === node
					? { ...press, released: true }
					: null;
		};
		const cancel = () => {
			press = null;
		};
		const click = (event: MouseEvent) => {
			const current = press;
			press = null;
			if (current?.released && event.button === 0 && event.target === node) onDismiss();
		};
		node.addEventListener("pointerdown", down, true);
		node.addEventListener("pointerup", up, true);
		node.addEventListener("pointercancel", cancel, true);
		node.addEventListener("click", click, true);
		return () => {
			node.removeEventListener("pointerdown", down, true);
			node.removeEventListener("pointerup", up, true);
			node.removeEventListener("pointercancel", cancel, true);
			node.removeEventListener("click", click, true);
		};
	};
}

/** A modal dialog's layer, attached to its backdrop: Escape closes it
 *  (newest layer first), a genuine backdrop click runs `onBackdrop`
 *  (`close` unless the dialog guards it), and outside clicks are the
 *  backdrop's. */
export function modalLayer(close: () => void, onBackdrop: () => void = close) {
	return (node: HTMLElement) => {
		const offLayer = dismissLayer(close, { clickOutside: false });
		const offBackdrop = backdropDismiss(onBackdrop)(node);
		return () => {
			offBackdrop();
			offLayer();
		};
	};
}
