<script lang="ts">
	import { tick, type Snippet } from "svelte";
	import { computeMenuPlacement } from "./menu-placement";

	let {
		anchor,
		testid,
		preferredSide,
		align = "right",
		menuClass,
		children,
	}: {
		anchor?: HTMLElement | null;
		testid: string;
		preferredSide: "up" | "down";
		align?: "left" | "right";
		menuClass: string;
		children: Snippet;
	} = $props();

	let placed = $state<{ side: "up" | "down"; style: string; maxHeight: number } | null>(null);
	let menu = $state<HTMLDivElement | null>(null);

	function compute(rect: DOMRect, contentHeight: number) {
		const placement = computeMenuPlacement(
			{ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
			{ width: window.innerWidth, height: window.innerHeight },
			contentHeight,
			preferredSide,
			align,
		);
		const style = Object.entries(placement.style).map(([key, value]) => `${key}:${value}px`).join(";");
		return { side: placement.side, style, maxHeight: placement.maxHeight };
	}

	$effect(() => {
		if (typeof document === "undefined") return;
		let raf = 0;
		const place = () => {
			if (!anchor || !menu) return;
			placed = compute(anchor.getBoundingClientRect(), menu.scrollHeight);
			if (!menu.dataset.focused) {
				menu.dataset.focused = "1";
				void tick().then(() => {
					const input = menu?.querySelector<HTMLElement>("input");
					(input ?? menu)?.focus();
				});
			}
		};
		void tick().then(place);
		const rePlace = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(place);
		};
		window.addEventListener("scroll", rePlace, true);
		window.addEventListener("resize", rePlace);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("scroll", rePlace, true);
			window.removeEventListener("resize", rePlace);
		};
	});

	function onKeyDown(event: KeyboardEvent) {
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
		const { key } = event;
		if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
		const buttons = Array.from(menu?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
		if (buttons.length === 0) return;
		event.preventDefault();
		if (key === "Home") return buttons[0]?.focus();
		if (key === "End") return buttons[buttons.length - 1]?.focus();
		const delta = key === "ArrowDown" ? 1 : -1;
		const idx = buttons.findIndex((b) => b === document.activeElement);
		const base = idx === -1 ? (delta > 0 ? -1 : 0) : idx;
		buttons[(base + delta + buttons.length) % buttons.length]?.focus();
	}
</script>

<div
	bind:this={menu}
	data-testid={testid}
	data-lh-menu=""
	role="menu"
	tabindex={-1}
	onkeydown={onKeyDown}
	style={placed
		? `position:fixed;z-index:60;${placed.style};max-height:${placed.maxHeight}px;overflow-y:auto`
		: "position:fixed;left:0;top:0;visibility:hidden"}
	class="{menuClass} outline-none"
>
	{@render children()}
</div>
