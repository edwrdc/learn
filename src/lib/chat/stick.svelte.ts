/** The stick-to-bottom contract: follow the tail,
 *  release on a user scroll up, re-pin at the bottom, smooth resize catch-up. */
export class StickToBottom {
	scroller = $state<HTMLElement | null>(null);
	content = $state<HTMLElement | null>(null);
	isAtBottom = $state(true);
	private follow = true;
	private observer: ResizeObserver | null = null;
	private initial = true;

	attach(scroller: HTMLElement): void {
		this.scroller = scroller;
		scroller.addEventListener("scroll", this.onScroll, { passive: true });
	}

	detach(scroller: HTMLElement): void {
		scroller.removeEventListener("scroll", this.onScroll);
	}

	attachContent(node: HTMLElement): void {
		this.content = node;
		this.observer?.disconnect();
		this.initial = true;
		this.observer = new ResizeObserver(() => this.onResize());
		this.observer.observe(node);
		this.onResize();
	}

	detachContent(): void {
		this.observer?.disconnect();
		this.observer = null;
	}

	private distance(): number {
		const el = this.scroller;
		if (!el) return 0;
		return el.scrollHeight - el.clientHeight - el.scrollTop;
	}

	private onScroll = (): void => {
		const d = this.distance();
		if (d > 8) this.follow = false;
		else if (d <= 1) this.follow = true;
		this.isAtBottom = d <= 1;
	};

	private onResize(): void {
		if (!this.scroller || !this.content) return;
		if (this.initial) {
			this.initial = false;
			this.scroller.scrollTop = this.scroller.scrollHeight;
			this.isAtBottom = true;
			return;
		}
		if (!this.follow) return;
		this.scrollToBottom("smooth");
	}

	scrollToBottom(behavior: ScrollBehavior = "smooth"): void {
		const el = this.scroller;
		if (!el) return;
		this.follow = true;
		el.scrollTo({ top: el.scrollHeight, behavior });
		this.isAtBottom = true;
	}

	stopScroll(): void {
		this.follow = false;
	}

	scrollTo(top: number): void {
		const el = this.scroller;
		if (!el) return;
		this.follow = false;
		el.scrollTo({ top, behavior: "instant" });
	}
}
