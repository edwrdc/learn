import { renderMermaid } from "./mermaid";

/** A chart's rendered SVG (or the render error), re-rendered when the chart
 *  changes or on retry. Construct during component init; no chart, no render. */
export class MermaidRender {
	svg = $state<string | null>(null);
	error = $state<string | null>(null);
	#attempt = $state(0);

	constructor(chart: () => string | undefined) {
		$effect(() => {
			const source = chart();
			void this.#attempt;
			this.svg = null;
			this.error = null;
			if (source === undefined) return;
			let cancelled = false;
			void renderMermaid(source)
				.then((svg) => {
					if (!cancelled) this.svg = svg;
				})
				.catch((err: unknown) => {
					if (!cancelled) this.error = err instanceof Error ? err.message : String(err);
				});
			return () => {
				cancelled = true;
			};
		});
	}

	retry = (): void => {
		this.#attempt += 1;
	};
}
