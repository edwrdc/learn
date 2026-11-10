/** Svelte ports of the React chrome SSR pins: abort dialog, compaction and
 *  phase dividers, queued steers, the live tool card, the reading-thinking
 *  field, and the empty-graph chrome. */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { closeSvelteSsr, renderSvelte } from "./support-svelte-ssr.ts";

after(closeSvelteSsr);

const html = async (path: string, props: Record<string, unknown> = {}) => (await renderSvelte(path, props)).body.replace(/<!--[^>]*-->/g, "");

describe("abort turn dialog", () => {
	it("turn mode names the turn, the partial-stays promise, and Abort", async () => {
		const body = await html("/src/lib/chat/AbortTurnDialog.svelte", { mode: "turn", onClose: () => {}, onConfirm: () => {} });
		assert.ok(body.includes('data-testid="abort-turn-dialog"'));
		assert.match(body, /Abort this turn\?/);
		assert.match(body, /The partial answer stays in the transcript\./);
		assert.match(body, /Cancel/);
		assert.match(body, /Abort/);
	});

	it("question mode names the dismissal and never leaks the abort copy", async () => {
		const body = await html("/src/lib/chat/AbortTurnDialog.svelte", { mode: "question", onClose: () => {}, onConfirm: () => {} });
		assert.match(body, /Dismiss this question\?/);
		assert.match(body, /Skipped — the teacher moves on without it\./);
		assert.match(body, /Dismiss/);
		assert.ok(!body.includes("Abort this turn"));
	});

	it("the confirm action is destructive; cancel is not", async () => {
		const body = await html("/src/lib/chat/AbortTurnDialog.svelte", { mode: "turn", onClose: () => {}, onConfirm: () => {} });
		const confirmAt = body.indexOf('data-testid="abort-turn-confirm"');
		const cancelAt = body.indexOf('data-testid="abort-turn-cancel"');
		assert.ok(confirmAt > -1 && cancelAt > -1);
		assert.match(body.slice(confirmAt, body.indexOf("</button>", confirmAt)), /destructive/);
		assert.ok(!body.slice(cancelAt, body.indexOf("</button>", cancelAt)).includes("destructive"));
	});

	it("closed renders nothing", async () => {
		assert.equal(await html("/src/lib/chat/AbortTurnDialog.svelte", { mode: null, onClose: () => {}, onConfirm: () => {} }), "");
	});
});

const compaction = {
	content: "[SESSION HISTORY COMPACTED]\n\nTHE LEARNER'S UNDERSTANDING: …",
	details: { firstKeptMessageId: "kept_1", tokensBefore: 152000, at: "2026-10-05T00:00:00.000Z" },
};

describe("compaction dividers", () => {
	it("moment divider is minimal, centered, no rules and no summary text", async () => {
		const body = await html("/src/lib/chat/CompactionDivider.svelte", { data: compaction });
		assert.ok(body.includes('data-testid="compaction-divider"'));
		assert.ok(body.includes("Context compacted"));
		assert.ok(!body.includes("border-t-2"));
		assert.ok(!body.includes("[SESSION HISTORY COMPACTED]"));
		assert.ok(!body.includes("THE LEARNER"));
		assert.ok(!body.includes("<button"));
	});

	it("cut divider carries dotted rules and the token count", async () => {
		const body = await html("/src/lib/chat/CompactionDivider.svelte", { data: compaction, cut: true });
		assert.ok(body.includes('data-testid="compaction-cut-divider"'));
		assert.ok(body.includes("border-t-2 border-dotted"));
		assert.ok(body.includes("History compacted"));
		assert.ok(body.includes("152k tok"));
		assert.ok(!body.includes("<button"));
	});
});

describe("phase chrome", () => {
	it("the chip is a flat label, never a pill or spinner", async () => {
		for (const [phase, label] of [["probe", "Probing"], ["plan", "Planning"], ["teach", "Teaching"]] as const) {
			const body = await html("/src/lib/chat/PhaseChip.svelte", { phase });
			assert.ok(body.includes('data-testid="phase-chip"'));
			assert.ok(body.includes(`data-phase="${phase}"`));
			assert.ok(body.includes(label));
			assert.ok(!body.includes("rounded-full"));
			assert.ok(!body.includes("braille-spinner"));
		}
	});

	it("the plan seam renders dotted rules and its label", async () => {
		const plan = await html("/src/lib/chat/PhaseDivider.svelte", { phase: "plan" });
		assert.ok(plan.includes('data-testid="phase-divider-plan"'));
		assert.ok(plan.includes("border-dotted"));
		assert.match(plan, /Planning/);
	});

	it("the teach seam labels itself with no count and no phase color", async () => {
		const body = await html("/src/lib/chat/PhaseDivider.svelte", { phase: "teach" });
		assert.ok(body.includes('data-testid="phase-divider-teach"'));
		assert.match(body, /Teaching/);
		assert.ok(!body.includes("border-phase-"));
		assert.ok(!body.includes("nodes"));
	});

	it("probe renders no boundary", async () => {
		assert.equal(await html("/src/lib/chat/PhaseDivider.svelte", { phase: "probe" }), "");
	});
});

describe("queued steers", () => {
	it("one quiet truncated right-aligned line per steer, no chrome", async () => {
		const body = await html("/src/lib/chat/QueuedSteers.svelte", {
			steers: [
				{ id: "steer_a", text: "also cover Venus while you are at it, please and thank you" },
				{ id: "steer_b", text: "short one" },
			],
		});
		assert.match(body, /data-testid="queued-steers"/);
		assert.equal(body.match(/<span/g)?.length, 2);
		assert.match(body, /truncate/);
		assert.match(body, /items-end/);
		assert.doesNotMatch(body, /bg-|border|rounded/);
		assert.match(body, /also cover Venus/);
	});

	it("an empty queue renders nothing", async () => {
		assert.equal(await html("/src/lib/chat/QueuedSteers.svelte", { steers: [] }), "");
	});
});

describe("live tool card", () => {
	const part = (tool: string, input: unknown) => ({ type: `tool-${tool}`, toolCallId: "c1", state: "input-streaming", input });

	it("spinner + activity label + headline arg + streaming input", async () => {
		const body = await html("/src/lib/artifacts/LiveToolCard.svelte", { part: part("read", { path: "notes.md" }) });
		assert.match(body, /data-testid="live-tool-card"/);
		assert.match(body, /data-testid="braille-spinner"/);
		assert.match(body, /Reading a file…/);
		assert.match(body, /notes\.md/);
		assert.match(body, /Input \(streaming\)/);
	});

	it("unknown tools stay generic and jobs get dispatch labels", async () => {
		assert.match(await html("/src/lib/artifacts/LiveToolCard.svelte", { part: part("mystery_tool", {}) }), /Working…/);
		assert.match(await html("/src/lib/artifacts/LiveToolCard.svelte", { part: part("research", { query: "x" }) }), /Dispatching research…/);
	});

	it("no input yet renders a placeholder, not an empty pre", async () => {
		const body = await html("/src/lib/artifacts/LiveToolCard.svelte", { part: part("grep", undefined) });
		assert.match(body, /<pre[^>]*>…<\/pre>/);
	});
});

describe("reading-thinking field", () => {
	it("labels itself and invites thinking while reading", async () => {
		const body = await html("/src/lib/chat/ReadingThinking.svelte", { value: "", onChange: () => {}, claim: false });
		assert.match(body, /Thinking while reading/);
		assert.match(body, /Whatever comes to mind as you read\./);
	});
});

describe("empty graph chrome", () => {
	it("Import Notes renders; search, settings and chains stay out", async () => {
		const body = await html("/src/lib/home/GraphView.svelte");
		assert.ok(body.includes('data-testid="import-notes"'));
		assert.ok(body.includes("Import notes…"));
		assert.ok(!body.includes("Search nodes…"));
		assert.ok(!body.includes("lucide-settings"));
		assert.ok(!body.includes('data-testid="open-chain-table"'));
	});
});
