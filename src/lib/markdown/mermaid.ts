/** The app's ONE mermaid renderer:
 *  dark theme, strict security, 16px base font, a unique id per render. */
import type { MermaidConfig } from "mermaid";

export const MERMAID_FONT_SIZE = 16;

const mermaidTheme: MermaidConfig = {
	fontFamily: "ui-sans-serif, system-ui, sans-serif",
	fontSize: MERMAID_FONT_SIZE,
	securityLevel: "strict",
	theme: "dark",
};

let mermaidModule: Promise<{ default: { initialize: (c: MermaidConfig) => void; render: (id: string, chart: string) => Promise<{ svg: string }> } }> | null = null;
let initialized = false;

export async function renderMermaid(chart: string): Promise<string> {
	mermaidModule ??= import("mermaid") as never;
	const mermaid = (await mermaidModule).default;
	if (!initialized) {
		mermaid.initialize({ startOnLoad: false, ...mermaidTheme });
		initialized = true;
	}
	const id = `lh-mermaid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
	const { svg } = await mermaid.render(id, chart);
	return svg;
}

/** A chart svg's natural extent: viewBox first, declared width/height
 *  second, 600x400 last (the overlay fit math needs a positive box). */
export function chartSize(svg: string): { w: number; h: number } {
	const viewBox = /<svg[^>]*\bviewBox="([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)"/.exec(svg);
	if (viewBox) {
		const w = Number.parseFloat(viewBox[3]!);
		const h = Number.parseFloat(viewBox[4]!);
		if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { w, h };
	}
	const attr = (name: string): number | null => {
		const match = new RegExp(`<svg\\b[^>]*?\\b${name}\\s*=\\s*["'](\\d+(?:\\.\\d+)?)(?:px)?["']`, "i").exec(svg);
		if (!match) return null;
		const n = Number.parseFloat(match[1]!);
		return Number.isFinite(n) && n > 0 ? n : null;
	};
	const w = attr("width");
	const h = attr("height");
	if (w !== null && h !== null) return { w, h };
	return { w: 600, h: 400 };
}
