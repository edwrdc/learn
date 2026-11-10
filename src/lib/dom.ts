export function focusOnMount(enabled = true) {
	return (node: HTMLElement) => {
		if (!enabled) return;
		// Attachments can run on a detached fragment during mount; retry on
		// the next frame and once more after layout so the field is connected.
		node.focus({ preventScroll: true });
		const frame = requestAnimationFrame(() => {
			if (node.isConnected) node.focus({ preventScroll: true });
		});
		const timer = setTimeout(() => {
			if (node.isConnected && document.activeElement !== node) node.focus({ preventScroll: true });
		}, 60);
		return () => {
			cancelAnimationFrame(frame);
			clearTimeout(timer);
		};
	};
}
