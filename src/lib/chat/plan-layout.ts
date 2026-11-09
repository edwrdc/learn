/** Plan DAG geometry — dagre (mermaid's engine) + the app's SVG skin. */
import { graphlib } from "dagre-d3-es";
import { layout as dagreLayout } from "dagre-d3-es/src/dagre/index.js";
import { curveBasis, line } from "d3-shape";

export const PAD_X = 16;
export const NODE_W_MIN = 96;
export const NODE_H = 44;
const NARROW_CHARS = new Set(" ijltfr.,:;'!|()[]-\\");
const WIDE_CHARS = new Set("mwMW@");
const CAP_DIGIT = /[A-Z0-9]/;
export const LINE_H = 13;
export const GAP_X = 24;
export const GAP_Y = 48;
export const GRAPH_PAD = 8;
export const GLOW_MARGIN = 8;
export const GLOW_BLUR = 5;
export const GLOW_REACH = GLOW_MARGIN + 3 * GLOW_BLUR;
export const TEXT_CAP_SCALE = 16 / 12.5;
export const ARROW_HEAD =
	"M48,55.2C49.4,54.6 50.2,53.4 50.2,52C50.2,50.6 49.4,49.4 48,48.8C38.2,45.6 29.2,38.8 21,28.4C15.2,21.4 11.4,13.2 9.6,3.8C9,1.2 7.4,0 4.8,0C1.6,0 0,1.6 0,5L0.2,5.6C3.6,23 12.6,36.8 27.2,47.2L27.2,56.8C12.6,67.2 3.6,81 0.2,98.4L0,99C0,102.4 1.6,104 4.8,104C7.4,104 9,102.8 9.6,100.2C11.4,90.8 15.2,82.6 21,75.6C29.2,65.2 38.2,58.4 48,55.2Z";
export const STROKE_W = 1;
const HEAD_H = 16 * (STROKE_W / 1.5);
const HEAD_SCALE = HEAD_H / 104;
export const HEAD_W = 50.2 * HEAD_SCALE;
const HEAD_TIP_OVERHANG = (50.2 - 27.2) * HEAD_SCALE;
const DOCK_GAP = 4 * (STROKE_W / 1.5);
const STRAIGHT_RUN = 12;
const ENTRY_ANGLE_LIMIT = (40 * Math.PI) / 180;
const edgeLine = line<{ x: number; y: number }>()
	.x((p) => p.x)
	.y((p) => p.y)
	.curve(curveBasis);

export interface LayoutNode {
	id: string;
	title: string;
}

export function estimateLineWidth(lineText: string): number {
	let w = 0;
	for (const ch of lineText) {
		if (NARROW_CHARS.has(ch)) w += 3.1;
		else if (WIDE_CHARS.has(ch)) w += 9.2;
		else if (CAP_DIGIT.test(ch)) w += 6.0;
		else w += 5.4;
	}
	return w;
}

export function wrapTitle(title: string, maxChars = 28): string[] {
	const words = title.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [""];
	const atoms: string[] = [];
	for (const word of words) {
		for (let i = 0; i < word.length; i += maxChars) atoms.push(word.slice(i, i + maxChars));
	}
	const lines: string[] = [];
	for (const atom of atoms) {
		const last = lines[lines.length - 1];
		if (last !== undefined && last.length + 1 + atom.length <= maxChars) lines[lines.length - 1] = `${last} ${atom}`;
		else lines.push(atom);
	}
	return lines;
}

export function nodeWidth(lines: readonly string[]): number {
	const widest = Math.max(1, ...lines.map(estimateLineWidth));
	return Math.max(NODE_W_MIN, Math.ceil(widest) + 2 * PAD_X);
}

function faceNormal(border: { x: number; y: number }, box: { x: number; y: number; w: number; h: number }) {
	const d = { top: border.y - box.y, bottom: box.y + box.h - border.y, left: border.x - box.x, right: box.x + box.w - border.x };
	const face = (Object.keys(d) as Array<keyof typeof d>).reduce((a, b) => (d[a] <= d[b] ? a : b));
	switch (face) {
		case "top":
			return { x: 0, y: -1 };
		case "bottom":
			return { x: 0, y: 1 };
		case "left":
			return { x: -1, y: 0 };
		default:
			return { x: 1, y: 0 };
	}
}

export function edgePathD(
	points: Array<{ x: number; y: number }>,
	target?: { x: number; y: number; w: number; h: number },
): string {
	const pts = points.map((p) => ({ ...p }));
	if (pts.length >= 2) {
		const last = pts[pts.length - 1]!;
		const prev = pts[pts.length - 2]!;
		const dx = last.x - prev.x;
		const dy = last.y - prev.y;
		const len = Math.hypot(dx, dy) || 1;
		let ux = dx / len;
		let uy = dy / len;
		let tipx: number;
		let tipy: number;
		if (target) {
			const n = faceNormal(last, target);
			tipx = last.x + n.x * DOCK_GAP;
			tipy = last.y + n.y * DOCK_GAP;
			const v = { x: -ux, y: -uy };
			const vn = v.x * n.x + v.y * n.y;
			if (vn < Math.cos(ENTRY_ANGLE_LIMIT)) {
				const t = { x: v.x - vn * n.x, y: v.y - vn * n.y };
				const tl = Math.hypot(t.x, t.y);
				const that = tl > 0 ? { x: t.x / tl, y: t.y / tl } : { x: -n.y, y: n.x };
				const c = Math.cos(ENTRY_ANGLE_LIMIT);
				const s = Math.sin(ENTRY_ANGLE_LIMIT);
				v.x = c * n.x + s * that.x;
				v.y = c * n.y + s * that.y;
				ux = -v.x;
				uy = -v.y;
			}
		} else {
			tipx = last.x - ux * DOCK_GAP;
			tipy = last.y - uy * DOCK_GAP;
		}
		const M = { x: tipx - ux * HEAD_TIP_OVERHANG, y: tipy - uy * HEAD_TIP_OVERHANG };
		const Q = { x: M.x - ux * STRAIGHT_RUN, y: M.y - uy * STRAIGHT_RUN };
		pts.splice(pts.length - 1, 1, Q, M);
	}
	return edgeLine(pts) ?? "";
}

export function topoFor(nodes: readonly LayoutNode[], edges: ReadonlyArray<{ from: string; to: string }>) {
	const index = new Map(nodes.map((node, i) => [node.id, i] as const));
	const indegree = new Map<string, number>(nodes.map((node) => [node.id, 0] as const));
	const dependents = new Map<string, string[]>();
	for (const edge of edges) {
		if (!index.has(edge.from) || !index.has(edge.to)) continue;
		indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
		const list = dependents.get(edge.from);
		if (list) list.push(edge.to);
		else dependents.set(edge.from, [edge.to]);
	}
	const ready = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
	const order: LayoutNode[] = [];
	const depth = new Map<string, number>();
	const byId = new Map(nodes.map((node) => [node.id, node] as const));
	while (ready.length > 0) {
		ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
		const id = ready.shift()!;
		const node = byId.get(id);
		if (node) order.push(node);
		const d = depth.get(id) ?? 0;
		depth.set(id, d);
		for (const next of dependents.get(id) ?? []) {
			if ((depth.get(next) ?? -1) < d + 1) depth.set(next, d + 1);
			const left = (indegree.get(next) ?? 0) - 1;
			indegree.set(next, left);
			if (left === 0) ready.push(next);
		}
	}
	for (const node of nodes) {
		if (!depth.has(node.id)) {
			order.push(node);
			depth.set(node.id, 0);
		}
	}
	return { order, depth };
}

export function blockLayout(nodes: readonly LayoutNode[], edges: ReadonlyArray<{ from: string; to: string }>) {
	const x = new Map<string, number>();
	const y = new Map<string, number>();
	const nodeH = new Map<string, number>();
	const nodeW = new Map<string, number>();
	const edgePts = new Map<string, Array<{ x: number; y: number }>>();
	if (nodes.length === 0) return { x, y, nodeH, nodeW, edgePts, originX: 0, originY: 0, width: 0, height: 0 };
	const ids = new Set(nodes.map((n) => n.id));
	const routed: Array<{ from: string; to: string }> = [];
	const g = new graphlib.Graph({ compound: false, multigraph: true });
	g.setGraph({ rankdir: "TB", nodesep: GAP_X, ranksep: GAP_Y, marginx: 0, marginy: 0 });
	for (const n of nodes) {
		const lines = wrapTitle(n.title);
		const h = NODE_H + Math.max(0, lines.length - 2) * LINE_H;
		nodeH.set(n.id, h);
		nodeW.set(n.id, nodeWidth(lines));
		g.setNode(n.id, { width: nodeW.get(n.id)!, height: h });
	}
	for (const e of edges) {
		if (ids.has(e.from) && ids.has(e.to)) {
			g.setEdge(e.from, e.to, { label: "", width: 0, height: 0 });
			routed.push(e);
		}
	}
	dagreLayout(g, undefined);
	for (const n of nodes) {
		const pos = g.node(n.id);
		const h = nodeH.get(n.id) ?? NODE_H;
		const w = nodeW.get(n.id) ?? NODE_W_MIN;
		if (pos) {
			x.set(n.id, pos.x - w / 2);
			y.set(n.id, pos.y - h / 2);
		}
	}
	for (const e of routed) {
		const pts: Array<{ x: number; y: number }> | undefined = g.edge(e.from, e.to)?.points;
		if (pts) edgePts.set(`${e.from}->${e.to}`, pts.map((pt) => ({ x: pt.x, y: pt.y })));
	}
	let inkMinX = Infinity;
	let inkMinY = Infinity;
	let inkMaxX = -Infinity;
	let inkMaxY = -Infinity;
	const stretch = (px: number, py: number) => {
		if (px < inkMinX) inkMinX = px;
		if (py < inkMinY) inkMinY = py;
		if (px > inkMaxX) inkMaxX = px;
		if (py > inkMaxY) inkMaxY = py;
	};
	for (const n of nodes) {
		const nx = x.get(n.id);
		const ny = y.get(n.id);
		if (nx === undefined || ny === undefined) continue;
		stretch(nx, ny);
		stretch(nx + (nodeW.get(n.id) ?? NODE_W_MIN), ny + (nodeH.get(n.id) ?? NODE_H));
	}
	for (const e of routed) {
		const pts = edgePts.get(`${e.from}->${e.to}`);
		if (!pts) continue;
		const tx = x.get(e.to);
		const ty = y.get(e.to);
		const target =
			tx !== undefined && ty !== undefined
				? { x: tx, y: ty, w: nodeW.get(e.to) ?? NODE_W_MIN, h: nodeH.get(e.to) ?? NODE_H }
				: undefined;
		const nums = edgePathD(pts, target).match(/-?\d+(?:\.\d+)?/g);
		if (!nums) continue;
		for (let i = 0; i + 1 < nums.length; i += 2) stretch(parseFloat(nums[i]!), parseFloat(nums[i + 1]!));
	}
	const originX = Math.min(0, inkMinX === Infinity ? 0 : inkMinX);
	const originY = Math.min(0, inkMinY === Infinity ? 0 : inkMinY);
	return {
		x, y, nodeH, nodeW, edgePts, originX, originY,
		width: Math.max((g.graph().width ?? 0) - originX, inkMaxX === -Infinity ? 0 : inkMaxX - originX, 1),
		height: Math.max((g.graph().height ?? 0) - originY, inkMaxY === -Infinity ? 0 : inkMaxY - originY, 1),
	};
}

export interface PopupMessage {
	parts: ReadonlyArray<{ type: string; state?: string; input?: unknown; output?: unknown }>;
}

export function latestTree(messages: readonly PopupMessage[]) {
	for (let m = messages.length - 1; m >= 0; m--) {
		const parts = messages[m]?.parts;
		if (!parts) continue;
		for (let p = parts.length - 1; p >= 0; p--) {
			const part = parts[p]!;
			if (!part.type.startsWith("tool-plan_") || part.state !== "output-available") continue;
			const output = part.output as { tree?: import("@/src/session/model").PlanTree } | undefined;
			if (output?.tree && Array.isArray(output.tree.nodes)) return output.tree;
		}
	}
	return null;
}

export function planExists(messages: readonly PopupMessage[]): boolean {
	const tree = latestTree(messages);
	return !!tree && tree.nodes.length > 0;
}
