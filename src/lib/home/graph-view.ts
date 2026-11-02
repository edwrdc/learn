/** Graph-home pure display seams: search predicate, live-rename patch,
 *  ledger seeding, and the pipeline cost fold. */
import type { GraphCostSummary, GraphNode, GraphSnapshot } from "@/src/core";

export function isNodeVisible(node: Pick<GraphNode, "name" | "statement">, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return node.name.toLowerCase().includes(q) || node.statement.toLowerCase().includes(q);
}

export function renameSessionsPatch(snapshot: Pick<GraphSnapshot, "sessions">, id: string, title: string): void {
	snapshot.sessions[id] = title;
}

export function seedMissingNodePositions(
	nodes: readonly { id: string }[],
	positions: Map<string, { x: number; y: number }>,
): Map<string, { x: number; y: number }> {
	if (positions.size === 0 || nodes.every((node) => positions.has(node.id))) return positions;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of positions.values()) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	const radius = Math.max(maxX - minX, maxY - minY, 40) * 0.7 + 20;
	const missing = nodes.filter((node) => !positions.has(node.id));
	missing.forEach((node, i) => {
		let h = 0x811c9dc5;
		for (let c = 0; c < node.id.length; c++) {
			h ^= node.id.charCodeAt(c);
			h = (h * 0x01000193) >>> 0;
		}
		const angle = ((h / 0xffffffff) * 2 * Math.PI + i * 2.39996323) % (2 * Math.PI);
		positions.set(node.id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
	});
	return positions;
}

export function displayCostTotals(costs: Pick<GraphCostSummary, "stages">): { totalDollars: number; unpricedRuns: number } {
	return {
		totalDollars: costs.stages.extraction.dollars + costs.stages.audit.dollars,
		unpricedRuns: costs.stages.extraction.unpricedRuns + costs.stages.audit.unpricedRuns,
	};
}
