/** Hover/focus tooltips without wrapper DOM — an attachment on the control
 *  itself: the label plus the action's LIVE binding ("Dictate (⌘D)"), 500ms
 *  hover delay, hides on leave/blur/Escape. */
import { bindingForAction, formatBinding, type KeyAction } from "@/src/settings/model";

const TOOLTIP_DELAY_MS = 500;

export function hintText(label: string, action?: KeyAction, binding?: string): string {
	const live = action ? formatBinding(bindingForAction(action)) : binding ? formatBinding(binding) : "";
	return live ? `${label} (${live})` : label;
}

type HintSide = "top" | "bottom" | "left" | "right";

export function hint(label: string, options: { action?: KeyAction; binding?: string; side?: HintSide } = {}) {
	return (node: HTMLElement) => {
		if (typeof document === "undefined") return;
		const side = options.side ?? "top";
		const text = hintText(label, options.action, options.binding);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let tip: HTMLDivElement | null = null;

		const hide = () => {
			clearTimeout(timer);
			tip?.remove();
			tip = null;
		};
		const place = () => {
			if (!tip) return;
			const rect = node.getBoundingClientRect();
			const gap = 6;
			const t = tip.getBoundingClientRect();
			let left = rect.left + rect.width / 2 - t.width / 2;
			let top = rect.top - t.height - gap;
			if (side === "bottom") top = rect.bottom + gap;
			if (side === "left") {
				left = rect.left - t.width - gap;
				top = rect.top + rect.height / 2 - t.height / 2;
			}
			if (side === "right") {
				left = rect.right + gap;
				top = rect.top + rect.height / 2 - t.height / 2;
			}
			left = Math.max(4, Math.min(left, window.innerWidth - t.width - 4));
			top = Math.max(4, Math.min(top, window.innerHeight - t.height - 4));
			tip.style.left = `${left}px`;
			tip.style.top = `${top}px`;
		};
		const show = () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				if (!node.isConnected) return;
				tip = document.createElement("div");
				tip.setAttribute("role", "tooltip");
				tip.textContent = text;
				tip.style.cssText =
					"position:fixed;z-index:70;pointer-events:none;max-width:18rem;border-radius:6px;" +
					"background:var(--popover);color:var(--popover-foreground);border:1px solid var(--border);" +
					"padding:4px 8px;font-size:12px;line-height:1.4;box-shadow:0 4px 12px rgb(0 0 0 / 0.35);";
				document.body.appendChild(tip);
				place();
			}, TOOLTIP_DELAY_MS);
		};

		node.addEventListener("pointerenter", show);
		node.addEventListener("pointerleave", hide);
		node.addEventListener("focus", show);
		node.addEventListener("blur", hide);
		node.addEventListener("pointerdown", hide);
		window.addEventListener("scroll", hide, true);

		return () => {
			hide();
			node.removeEventListener("pointerenter", show);
			node.removeEventListener("pointerleave", hide);
			node.removeEventListener("focus", show);
			node.removeEventListener("blur", hide);
			node.removeEventListener("pointerdown", hide);
			window.removeEventListener("scroll", hide, true);
		};
	};
}
