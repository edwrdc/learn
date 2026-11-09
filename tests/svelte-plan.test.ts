/** Svelte ports of the plan layout and plan surfaces. */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { PlanBlockData } from "../src/session/model/types.ts";
import type { PlanTree } from "../src/session/model/plan-types.ts";
import {
	blockLayout,
	edgePathD,
	estimateLineWidth,
	GAP_X,
	NODE_H,
	NODE_W_MIN,
	nodeWidth,
	wrapTitle,
} from "../src/lib/chat/plan-layout.ts";
import { closeSvelteSsr, renderSvelte } from "./support-svelte-ssr.ts";

after(closeSvelteSsr);
const html = async (path: string, props: Record<string, unknown>) =>
	(await renderSvelte(path, props)).body.replace(/<!--[^>]*-->/g, "");

const CHAIN: PlanTree = {
	nodes: [
		{ id: "a", title: "Alpha node" },
		{ id: "b", title: "Beta node" },
		{ id: "c", title: "Gamma node" },
	],
	edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
	version: 1,
};

describe("plan layout (pure)", () => {
	it("layers a chain top-down, one node per depth row", () => {
		const layout = blockLayout(CHAIN.nodes, CHAIN.edges);
		const W = nodeWidth(wrapTitle("Alpha node"));
		assert.equal(W, NODE_W_MIN);
		assert.equal(nodeWidth(wrapTitle("Gamma node")), NODE_W_MIN);
		assert.equal(layout.width, NODE_W_MIN);
		assert.equal(layout.height, 3 * NODE_H + 2 * 48);
		assert.equal(layout.nodeW.get("a"), W);
	});

	it("centers same-depth nodes and tolerates dangling edges", () => {
		const nodes = [{ id: "r", title: "Root" }, { id: "x", title: "Left" }, { id: "y", title: "Right" }];
		const layout = blockLayout(nodes, [{ from: "r", to: "x" }, { from: "r", to: "y" }, { from: "ghost", to: "r" }]);
		const W = nodeWidth(wrapTitle("Root"));
		assert.equal(layout.width, 2 * W + GAP_X);
		assert.equal(layout.x.get("r"), (2 * W + GAP_X - W) / 2);
		assert.ok(layout.x.get("x") === 0 && layout.x.get("y") === W + GAP_X);
	});

	it("edgePathD keeps straight runs on-axis and pulls the mouth back", () => {
		const d = edgePathD([{ x: 80, y: 44 }, { x: 80, y: 68 }, { x: 80, y: 92 }]);
		assert.ok(d.startsWith("M80,44"));
		assert.ok(d.endsWith("L80,86.974"));
		const xs = [...d.matchAll(/(?:[MLC]|,)(-?[\d.]+),/g)].map((match) => match[1]);
		assert.ok(xs.length > 0 && xs.every((value) => value === "80"));
		assert.equal(edgePathD([{ x: 80, y: 44 }, { x: 80, y: 68 }, { x: 80, y: 92 }], { x: 0, y: 92, w: 160, h: 44 }), d);
	});

	it("edgePathD clamps the entry to ±40°", () => {
		const box = { x: 20, y: 100, w: 160, h: 44 };
		const clamped = edgePathD([{ x: 70, y: 70 }, { x: 100, y: 100 }], box);
		assert.ok(clamped.endsWith("L98.484,95.526"));
		const free = edgePathD([{ x: 90, y: 40 }, { x: 100, y: 100 }], box);
		assert.ok(free.endsWith("L99.612,95.006"));
	});

	it("wrapTitle wraps greedily and hard-chunks oversized words", () => {
		assert.deepEqual(wrapTitle("Chain rule intuition"), ["Chain rule intuition"]);
		assert.deepEqual(wrapTitle("Chain rule intuition and fluency"), ["Chain rule intuition and", "fluency"]);
		assert.deepEqual(wrapTitle("supercalifragilisticexpialidocious word"), ["supercalifragilisticexpialid", "ocious word"]);
		assert.deepEqual(wrapTitle("supercalifragilistic"), ["supercalifragilistic"]);
	});

	it("nodeWidth hugs the wrapped text", () => {
		assert.equal(nodeWidth(["supercalifragilistic"]), 117);
		assert.equal(nodeWidth(wrapTitle("Symmetry and orthogonal complements")), 149);
		assert.equal(nodeWidth(["a"]), NODE_W_MIN);
		assert.ok(Math.abs(estimateLineWidth("The normal-form ladder") - 106.3) < 0.5);
	});

});

describe("plan block", () => {
	const data: PlanBlockData = {
		kind: "full",
		at: "2026-09-09T12:00:00Z",
		current: null,
		nodes: [{ id: "a", title: "Alpha node", status: "visited" }, { id: "b", title: "Beta node", status: "upcoming" }],
		edges: [{ from: "a", to: "b" }],
	};

	it("borderless, prose font, hugged boxes, carried statuses, open affordance", async () => {
		const body = await html("/src/lib/chat/PlanBlock.svelte", { data, onOpen: () => {} });
		assert.match(body, /data-testid="plan-block-full"/);
		assert.ok(!/data-testid="plan-block-full"[^>]*border/.test(body));
		assert.match(body, /<svg[^>]*class="block h-auto w-full mx-auto"/);
		assert.match(body, /<svg[^>]*font-family: var\(--font-prose\)/);
		assert.match(body, /<rect[^>]*stroke-width="1"/);
		assert.match(body, /<rect[^>]*class="fill-card stroke-white"/);
		assert.match(body, /<text[^>]*x="48"[^>]*text-anchor="middle"/);
		assert.ok(!/x="12"/.test(body));
		assert.match(body, /data-testid="plan-node-a" data-status="visited"/);
		assert.match(body, /data-testid="plan-node-b" data-status="upcoming"/);
		assert.ok(body.includes('aria-label="Open the full plan"'));
	});
});

function messages(): Array<{ parts: unknown[] }> {
	return [
		{ parts: [{ type: "tool-plan_init", state: "output-available", output: { ok: true, tree: CHAIN } }] },
		{ parts: [{ type: "tool-quiz", state: "output-available", input: { nodeId: "a" }, output: { correct: true } }] },
		{ parts: [{ type: "tool-quiz", state: "input-available", input: { nodeId: "b" } }] },
	];
}

describe("plan popup", () => {
	it("derives statuses, glows the current node, dims edges and hides until fitted", async () => {
		const body = await html("/src/lib/chat/PlanPopup.svelte", { messages: messages(), onClose: () => {} });
		assert.ok(body.includes('data-testid="plan-popup"'));
		assert.match(body, /data-testid="plan-node-a" data-status="visited"/);
		assert.match(body, /data-testid="plan-node-b" data-status="current"/);
		assert.match(body, /data-testid="plan-node-c" data-status="upcoming"/);
		assert.match(body, /fill-yellow-400\/25/);
		assert.match(body, /feGaussianBlur/);
		assert.doesNotMatch(body, /animate-pulse/);
		assert.match(body, /marker-end="url\(#.*-dim\)"/);
		assert.match(body, /live — statuses derive from your check outcomes/);
		assert.match(body, /opacity: ?0[;,}]/);
	});

	it("dims an edge when either end is gray", async () => {
		const tree: PlanTree = {
			nodes: [{ id: "x", title: "Gray origin" }, { id: "y", title: "Covered middle" }, { id: "z", title: "Covered latest" }],
			edges: [{ from: "x", to: "y" }, { from: "y", to: "z" }],
			version: 1,
		};
		const msgs = [
			{ parts: [{ type: "tool-plan_init", state: "output-available", output: { ok: true, tree } }] },
			{ parts: [{ type: "tool-quiz", state: "output-available", input: { nodeId: "y" }, output: { correct: true } }] },
			{ parts: [{ type: "tool-quiz", state: "output-available", input: { nodeId: "z" }, output: { correct: true } }] },
		];
		const body = await html("/src/lib/chat/PlanPopup.svelte", { messages: msgs, onClose: () => {} });
		assert.equal((body.match(/marker-end="url\(#.*-dim\)"/g) ?? []).length, 1);
		assert.match(body, /<path[^>]*class="fill-none stroke-border"/);
		assert.match(body, /<path[^>]*class="fill-none stroke-white"/);
	});

	it("renders the empty state without a plan", async () => {
		assert.match(await html("/src/lib/chat/PlanPopup.svelte", { messages: [{ parts: [] }], onClose: () => {} }), /No plan in this session yet\./);
	});
});

describe("plan marginalia", () => {
	it("renders nothing until a tree exists", async () => {
		assert.equal(await html("/src/lib/chat/PlanMarginalia.svelte", { messages: [] }), "");
	});

	it("renders the full padded plan and glows the current node", async () => {
		const body = await html("/src/lib/chat/PlanMarginalia.svelte", { messages: messages() });
		assert.match(body, /aria-label="Plan diagram"/);
		assert.match(body, /data-testid="plan-node-b" data-status="current"/);
		assert.ok(body.includes("fill-yellow-400/25"));
		const layout = blockLayout(CHAIN.nodes, CHAIN.edges);
		const pad = 24;
		assert.ok(body.includes(`viewBox="${-pad} ${-pad} ${layout.width + 2 * pad} ${layout.height + 2 * pad}"`));
		assert.ok(body.includes("font-family: var(--font-prose)"));
	});
});
