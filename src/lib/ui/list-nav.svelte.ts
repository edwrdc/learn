/** Keyboard walking for a searchable menu list: the search field's arrows
 *  move the highlight, Enter picks the highlighted item (or the first), and
 *  the list keeps the highlighted `[data-idx]` row in view. */
export class ListNav<T> {
	/** The highlighted row; null until an arrow key moves it. */
	index = $state<number | null>(null);

	constructor(
		private readonly items: () => readonly T[],
		private readonly pick: (item: T) => void,
	) {}

	reset = (): void => {
		this.index = null;
	};

	keydown = (event: KeyboardEvent): void => {
		const items = this.items();
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			event.stopPropagation();
			if (items.length === 0) return;
			this.index =
				event.key === "ArrowDown" ? Math.min((this.index ?? -1) + 1, items.length - 1) : Math.max((this.index ?? items.length) - 1, 0);
		} else if (event.key === "Enter") {
			const chosen = items[this.index ?? 0];
			if (chosen === undefined) return;
			event.preventDefault();
			event.stopPropagation();
			this.pick(chosen);
		}
	};

	/** Attach to the list element. */
	scroll = (list: HTMLElement): void => {
		if (this.index === null) return;
		list.querySelector<HTMLElement>(`[data-idx="${this.index}"]`)?.scrollIntoView({ block: "nearest" });
	};
}
