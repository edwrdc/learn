export interface SessionMermaidApi {
	openMermaid: (chart: string) => void;
	openFigure: (svg: string, inverted: boolean) => void;
}
