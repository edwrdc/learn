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
