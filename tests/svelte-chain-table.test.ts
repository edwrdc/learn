/** Svelte ports of the chain-table grouping/chrome pins. The overlay owns
 *  expansion/search as internal state, so the row-level interaction pins
 *  are browser-verified; grouping, the conclusion-cluster law and the
 *  collapsed default are pure SSR of the shipped component. */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { GraphChain, GraphNode } from "../src/graph/model/types.ts";
import { closeSvelteSsr, renderSvelte } from "./support-svelte-ssr.ts";

after(closeSvelteSsr);
const html = async (path: string, props: Record<string, unknown>) =>
	(await renderSvelte(path, props)).body.replace(/<!--[^>]*-->/g, "");

function node(id: string, name: string, statement: string, chatId: string | null): GraphNode {
	return {
		id,
		name,
		statement,
		aliases: [],
		state: "new",
		createdAt: "2026-09-20T10:00:00.000Z",
		provenance: chatId === null ? [] : [{ chatId, messageId: `m_${id}` }],
	} as unknown as GraphNode;
}

const NODES: GraphNode[] = [
	node("a", "Premise one", "Statement A.", "chat1"),
	node("b", "Premise two", "Statement B.", "chat2"),
	node("c1", "Conclusion", "Statement C.", "chat1"),
	node("d", "Support", "Statement D.", null),
	node("e", "Follow-up", "Statement E with keyword zebra.", "notes1"),
	node("solo", "Standalone", "Statement S.", "chat1"),
	node("orphan", "Orphan", "Statement O.", null),
];
const CHAINS: GraphChain[] = [
	{ id: "c1", premises: ["a", "b"], conclusion: "c1", provenance: [], createdAt: "2026-09-20T10:00:00.000Z" },
	{ id: "e", premises: ["d"], conclusion: "e", provenance: [], createdAt: "2026-09-20T10:00:00.000Z" },
];
const props = {
	open: true,
	snapshot: {
		propositions: NODES,
		chains: CHAINS,
		sessions: { chat1: "Ethics lesson", chat2: "Second chat" },
		fileSources: { notes1: "notes/raw/ethics.md" },
	},
	onClose: () => {},
};

describe("chain table overlay", () => {
	it("closed renders nothing", async () => {
		assert.equal(await html("/src/lib/home/ChainTableOverlay.svelte", { ...props, open: false }), "");
	});

	it("collapsed: cluster rows render; chain rows and chips do not", async () => {
		const body = await html("/src/lib/home/ChainTableOverlay.svelte", props);
		assert.ok(body.includes('data-testid="chain-table"'));
		assert.match(body, /\d+ chains · \d+ nodes/, "top-bar counts");
		assert.ok(body.includes('data-testid="cluster-group-chat1"'));
		assert.ok(body.includes('data-testid="cluster-group-notes1"'));
		assert.ok(body.includes("Ethics lesson"));
		assert.ok(body.includes("notes/raw/ethics.md"));
		assert.ok(!body.includes('data-testid="chain-row-c1"'));
		assert.ok(!body.includes("Premise one"));
	});

	it("a premise-only birth never becomes a group — chains live in their conclusion's cluster", async () => {
		const body = await html("/src/lib/home/ChainTableOverlay.svelte", props);
		assert.ok(!body.includes("cluster-group-chat2"));
		assert.ok(!body.includes("Second chat"));
	});

	it("unnameable conclusion births form one muted unlabeled group", async () => {
		const body = await html("/src/lib/home/ChainTableOverlay.svelte", props);
		assert.ok(body.includes("unlabeled"));
		assert.ok(body.includes("cluster-group-"));
	});

	it("cluster rows carry checkbox, counts, newest date and the notes kind", async () => {
		const body = await html("/src/lib/home/ChainTableOverlay.svelte", props);
		assert.ok(body.includes('data-testid="cluster-checkbox-chat1"'));
		assert.ok(body.includes('data-testid="cluster-checkbox-notes1"'));
		assert.match(body, /2026-09-20/);
		assert.match(body, />notes</);
	});

	it("all three columns sort and the shared top bar/search/close render", async () => {
		const body = await html("/src/lib/home/ChainTableOverlay.svelte", props);
		for (const id of ["sort-name", "sort-props", "sort-created"]) assert.ok(body.includes(`data-testid="${id}"`), id);
		assert.ok(body.includes('data-testid="chain-table-search"'));
		assert.ok(body.includes('data-testid="chain-table-close"'));
		assert.match(body, /aria-sort="ascending"/);
	});
});
