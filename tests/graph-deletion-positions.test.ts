import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deleteChatTraces } from "../src/graph/model/deletion.ts";
import type { GraphStore } from "../src/graph/model/ports.ts";
import type { GraphChain, GraphNode } from "../src/graph/model/types.ts";

const point = (chatId: string) => ({ chatId }) as unknown as GraphNode["provenance"][number];
const node = (id: string, chats: string[]): GraphNode =>
	({ id, name: id, statement: id, aliases: [], createdAt: "2026-11-01T00:00:00.000Z", provenance: chats.map(point) }) as GraphNode;

function memoryStore(nodes: GraphNode[], chains: GraphChain[], positions: Record<string, { x: number; y: number }>) {
	const state = { nodes, chains, positions };
	const store = {
		readNodes: () => state.nodes,
		readChains: () => state.chains,
		readCoverage: () => [],
		readCheckpoints: () => [],
		rewriteLedgers: (next: { nodes?: GraphNode[]; chains?: GraphChain[] }) => {
			if (next.nodes) state.nodes = next.nodes;
			if (next.chains) state.chains = next.chains;
		},
		readPositions: () => state.positions,
		writePositions: (next: Record<string, { x: number; y: number }>) => {
			state.positions = next;
		},
	};
	return { store: store as unknown as GraphStore, state };
}

describe("chat deletion positions", () => {
	it("a chain another session also asserted keeps its resting position", () => {
		const chain = { id: "arg_shared", premises: ["n_a", "n_b"], conclusion: "n_c", provenance: [point("chat_1"), point("chat_2")] } as GraphChain;
		const { store, state } = memoryStore(
			[node("n_a", ["chat_2"]), node("n_b", ["chat_2"]), node("n_c", ["chat_2"])],
			[chain],
			{ arg_shared: { x: 1, y: 2 }, n_a: { x: 0, y: 0 } },
		);
		deleteChatTraces(store, "chat_1", "delete-nodes");
		assert.equal(state.chains.length, 1, "the chain survives on chat_2's assertion");
		assert.deepEqual(state.positions.arg_shared, { x: 1, y: 2 });
	});
});
