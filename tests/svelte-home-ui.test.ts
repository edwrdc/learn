/** Svelte ports of the home/session chrome pins: create-on-send, composer
 *  actions, knowledge summary lines, sidebar rows, stats folds. */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { ChatListItem, ModelCatalogEntry, TurnUsage } from "../src/core/index.ts";
import { enterAction } from "../src/lib/chat/chat-logic.ts";
import { catalogLimits } from "../src/lib/state/model-catalog.ts";
import { knowledgeEmpty, knowledgeLines } from "../src/lib/home/minimal-home.ts";
import { startDraftSession } from "../src/lib/home/new-session.ts";
import { sessionMeta } from "../src/lib/shell/session-row.ts";
import { timeAgo } from "../src/lib/format.ts";
import { closeSvelteSsr, renderSvelte } from "./support-svelte-ssr.ts";

after(closeSvelteSsr);
const html = async (path: string, props: Record<string, unknown> = {}) =>
	(await renderSvelte(path, props)).body.replace(/<!--[^>]*-->/g, "");

function fakeFetch(id: string) {
	const calls: { url: string; method: string; body: unknown }[] = [];
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
		return new Response(JSON.stringify({ id }), { status: 200 });
	}) as typeof fetch;
	return { fetchImpl, calls };
}

describe("startDraftSession — create on first send", () => {
	it("creates the session titled with the first message and returns the prompt redirect", async () => {
		const { fetchImpl, calls } = fakeFetch("c_new");
		const target = await startDraftSession("teach me orbital mechanics", fetchImpl);
		assert.equal(target, "/chat/c_new?prompt=teach%20me%20orbital%20mechanics");
		assert.deepEqual(calls, [{ url: "/api/chats", method: "POST", body: { title: "teach me orbital mechanics" } }]);
	});

	it("empty or whitespace text never creates anything", async () => {
		const { fetchImpl, calls } = fakeFetch("never");
		assert.equal(await startDraftSession("", fetchImpl), null);
		assert.equal(await startDraftSession("   ", fetchImpl), null);
		assert.equal(calls.length, 0);
	});

	it("practice carries kind + picked propositions; no picks stays lean", async () => {
		const first = fakeFetch("c10");
		await startDraftSession("drill me", first.fetchImpl, "practice", [{ id: "n_1", name: "Parity", statement: "Odd + odd = even." }]);
		assert.deepEqual(first.calls[0]!.body, {
			title: "drill me",
			kind: "practice",
			graphContext: { propositions: [{ id: "n_1", name: "Parity", statement: "Odd + odd = even." }] },
		});
		const second = fakeFetch("c11");
		await startDraftSession("free practice", second.fetchImpl, "practice", []);
		assert.deepEqual(second.calls[0]!.body, { title: "free practice", kind: "practice" });
	});

	it("the teaching default writes no kind key", async () => {
		const { fetchImpl, calls } = fakeFetch("c8");
		await startDraftSession("orbital mechanics", fetchImpl);
		assert.deepEqual(calls[0]!.body, { title: "orbital mechanics" });
	});
});

describe("composer", () => {
	const render = (opts: { busy?: boolean; canSend?: boolean; placeholder?: string; nextProblem?: boolean } = {}) =>
		html("/src/lib/chat/Composer.svelte", {
			busy: opts.busy ?? false,
			value: "",
			onChange: () => {},
			onSend: () => {},
			onStop: () => {},
			canSend: opts.canSend ?? true,
			...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
			...(opts.nextProblem ? { nextProblem: true, onNext: () => {} } : {}),
		});

	it("default placeholder, send affordance and concentric radius", async () => {
		const body = await render();
		assert.match(body, /Ask, answer, or steer the lesson/);
		assert.ok(body.includes('aria-label="Send"'));
		assert.ok(body.includes("rounded-[10px]"));
		assert.ok(body.includes("size-10"));
	});

	it("placeholder is overridable and does not leak the session copy", async () => {
		const body = await render({ placeholder: "What do you want to learn?" });
		assert.match(body, /What do you want to learn\?/);
		assert.ok(!body.includes("Ask, answer"));
	});

	it("busy with text keeps Send; busy empty becomes Stop", async () => {
		assert.ok((await render({ busy: true, canSend: true })).includes('aria-label="Send"'));
		assert.ok((await render({ busy: true, canSend: false })).includes('aria-label="Stop"'));
	});

	it("disabled when there is nothing to send", async () => {
		assert.ok(/aria-label="Send"[^>]*disabled|disabled[^>]*aria-label="Send"/.test(await render({ canSend: false })));
	});

	it("the practice pause morphs to a green Next problem; text or busy wins it back", async () => {
		const next = await render({ canSend: false, nextProblem: true });
		assert.ok(next.includes('data-testid="next-problem-button"'));
		assert.match(next, /Next problem/);
		assert.ok(next.includes("bg-green-600"));
		assert.ok(!next.includes('aria-label="Send"'));
		assert.ok((await render({ canSend: true, nextProblem: true })).includes('aria-label="Send"'));
		assert.ok((await render({ busy: true, canSend: false, nextProblem: true })).includes('aria-label="Stop"'));
	});

	it("enterAction: steer, stop, send, next precedence", () => {
		assert.equal(enterAction({ busy: true, canSend: true }), "send");
		assert.equal(enterAction({ busy: true, canSend: false }), "stop");
		assert.equal(enterAction({ busy: false, canSend: true }), "send");
		assert.equal(enterAction({ busy: false, canSend: false }), "none");
		assert.equal(enterAction({ busy: false, canSend: false, nextProblem: true }), "next");
		assert.equal(enterAction({ busy: false, canSend: true, nextProblem: true }), "send");
		assert.equal(enterAction({ busy: true, canSend: false, nextProblem: true }), "stop");
	});
});

describe("knowledge summary lines", () => {
	const counts = { propositions: 12, chains: 5, teachSessions: 3, practiceSessions: 2, importedNotes: 4 };

	it("every count is its own line, graph block then sessions then notes", () => {
		assert.deepEqual(knowledgeLines(counts).map((line) => line.text), [
			"12 propositions",
			"5 chains",
			"3 teaching sessions",
			"2 practice sessions",
			"4 imported notes",
		]);
		assert.deepEqual(knowledgeLines(counts).map((line) => line.block), ["graph", "graph", "sessions", "sessions", "notes"]);
	});

	it("singularizes all five", () => {
		assert.deepEqual(
			knowledgeLines({ propositions: 1, chains: 1, teachSessions: 1, practiceSessions: 1, importedNotes: 1 }).map((line) => line.text),
			["1 proposition", "1 chain", "1 teaching session", "1 practice session", "1 imported note"],
		);
	});

	it("empty is exactly all-zero", () => {
		assert.equal(knowledgeEmpty({ propositions: 0, chains: 0, teachSessions: 0, practiceSessions: 0, importedNotes: 0 }), true);
		assert.equal(knowledgeEmpty(counts), false);
	});

	it("the SSR empty surface says so quietly", async () => {
		const body = await html("/src/lib/home/MinimalHome.svelte");
		assert.ok(body.includes('data-testid="knowledge-summary"'));
		assert.ok(body.includes("Nothing here yet"));
		assert.match(body, /0 propositions/);
		assert.match(body, /import notes/);
		assert.match(body, /class="h-4"/);
	});
});

function item(overrides: Partial<ChatListItem>): ChatListItem {
	return {
		id: "c1",
		title: "Test session",
		kind: "teach",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		messageCount: 4,
		phase: "probe",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
		...overrides,
	};
}

describe("sidebar session rows", () => {
	const row = (chat: ChatListItem, active = false) => html("/src/lib/shell/SessionRow.svelte", { chat, active, onOpen: () => {} });

	it("idle rows carry no phase decoration and no spinner", async () => {
		for (const phase of ["probe", "plan", "teach"] as const) {
			const body = await row(item({ phase }));
			assert.ok(!body.includes("session-dot"));
			assert.ok(!body.includes("braille-spinner"));
			assert.ok(!body.includes("bg-phase-"));
		}
	});

	it("a waiting question renders text, not motion", async () => {
		const body = await row(item({ phase: "teach", pendingQuestion: true }));
		assert.ok(!body.includes("session-dot"));
		assert.ok(!body.includes("braille-spinner"));
		assert.ok(body.includes("Waiting for input"));
		assert.ok(!body.includes("Waiting for your answer"));
	});

	it("a working row renders the only indicator: the ten-frame spinner", async () => {
		const body = await row(item({ phase: "plan", busy: true }));
		assert.ok(body.includes('data-testid="braille-spinner"'));
		assert.equal((body.match(/class="braille-frame"/g) ?? []).length, 10);
		assert.ok(body.includes('data-frame="0"'));
		assert.ok(body.includes("Working"));
		assert.ok(!body.includes("bg-attention"));
	});

	it("compacting outranks pending input", async () => {
		const body = await row(item({ compacting: true, pendingQuestion: true }));
		assert.match(body, /Compacting context ·/);
		assert.doesNotMatch(body, /Waiting for input/);
	});

	it("practice carries the dumbbell and the problem-waiting meta; teaching carries neither", async () => {
		const practice = await row(item({ kind: "practice", pendingProblem: true }));
		assert.match(practice, /Problem waiting ·/);
		assert.match(practice, /aria-label="Practice session"/);
		const teaching = await row(item({}));
		assert.doesNotMatch(teaching, /Practice session/);
	});

	it("the active row is marked by background alone", async () => {
		const body = await row(item({}), true);
		assert.ok(body.includes("bg-accent"));
		assert.ok(!body.includes("font-medium"));
	});

	it("sessionMeta picks the useful fact and timeAgo keeps its register", () => {
		const now = new Date("2026-01-02T12:00:00.000Z");
		assert.equal(sessionMeta(item({ updatedAt: now.toISOString() }), now), "just now");
		assert.equal(sessionMeta(item({ pendingQuestion: true, updatedAt: "2026-01-02T11:55:00.000Z" }), now), "Waiting for input · 5m ago");
		assert.equal(sessionMeta(item({ busy: true }), now), "Working…");
		assert.equal(sessionMeta(item({ compacting: true, updatedAt: "2026-01-02T09:00:00.000Z" }), now), "Compacting context · 3h ago");
		assert.equal(timeAgo("2025-06-02T12:00:00.000Z", now), "2025-06-02");
		assert.equal(timeAgo("2026-01-02T12:01:00.000Z", now), "just now");
	});
});

describe("stats bar", () => {
	const step = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined });
	const turn = (over: Partial<TurnUsage> = {}): TurnUsage => ({
		id: "t1",
		messageId: "m1",
		at: "2026-09-09T12:00:00Z",
		model: "openrouter:z-ai/glm-5.3-flash",
		steps: [step(10_000, 1_000)],
		...over,
	});

	it("no turns: no left figures, both controls read —", async () => {
		const body = await html("/src/lib/chat/StatsBar.svelte", { turns: [] });
		assert.match(body, /data-testid="stats-bar"/);
		assert.ok(!body.includes('data-testid="stats-summary"'));
		assert.ok(!body.includes('data-testid="stats-context"'));
		assert.ok(!body.includes('data-testid="stats-cost"'));
		assert.match(body, /data-testid="stats-model"[^>]*>\s*<span[^>]*>—<\/span>/);
		assert.match(body, /data-testid="stats-thinking"[^>]*>\s*<span[^>]*>—<\/span>/);
		assert.match(body, /data-testid="stats-model"[^>]*rounded-full[^>]*>/);
		assert.match(body, /▾/);
	});

	it("folds context usage and honest cost from the turn log", async () => {
		const body = await html("/src/lib/chat/StatsBar.svelte", { turns: [turn(), turn()] });
		assert.match(body, /data-testid="stats-context">11k</);
		assert.match(body, /data-testid="stats-cost">\$0\.0040</);
	});

	it("an unpriceable model shows — for cost, never a fake zero", async () => {
		const body = await html("/src/lib/chat/StatsBar.svelte", { turns: [turn({ model: "nope/unknown" })] });
		assert.match(body, /data-testid="stats-cost">—</);
		assert.match(body, /data-testid="stats-context">11k</);
	});

	it("catalogLimits keys provider:id and leaves missing models absent", () => {
		const entry = (over: Pick<ModelCatalogEntry, "id" | "provider" | "contextWindow">): ModelCatalogEntry => ({
			name: over.id,
			reasoning: false,
			input: ["text"],
			supportedLevels: [],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 32_768,
			...over,
		});
		const limits = catalogLimits({
			models: [
				entry({ id: "z-ai/glm-5.3-flash", provider: "openrouter", contextWindow: 1_048_576 }),
				entry({ id: "z-ai/glm-5.3-flash", provider: "zai", contextWindow: 200_000 }),
			],
		});
		assert.equal(limits.get("openrouter:z-ai/glm-5.3-flash"), 1_048_576);
		assert.equal(limits.get("zai:z-ai/glm-5.3-flash"), 200_000);
		assert.equal(limits.has("nope/unknown"), false);
	});
});

describe("new-session draft shell", () => {
	it("teach: composer blob, fresh-chat empty state, no chat id", async () => {
		const body = await html("/src/lib/home/NewSessionPage.svelte", { initialConfigured: true });
		assert.ok(body.includes('data-testid="composer"'));
		assert.ok(body.includes("The teacher will open by probing what you already know."));
		assert.ok(body.includes("pointer-events-none"));
		assert.match(body, /rounded-2xl[^>]*pointer-events-auto|pointer-events-auto[^>]*rounded-2xl/);
		assert.ok(!/\/chat\/c[a-z0-9_]+/.test(body));
	});

	it("practice swaps title, empty state, placeholder and carries the pick bar", async () => {
		const body = await html("/src/lib/home/NewSessionPage.svelte", { initialConfigured: true, mode: "practice" });
		assert.match(body, /New practice session/);
		assert.ok(body.includes("Pick nodes from your knowledge graph, describe what you want to practice, or bring your own problem."));
		assert.match(body, /What do you want to practice\?/);
		assert.match(body, /Pick nodes<\/button>/);
		assert.ok(body.includes('data-testid="practice-props-chip"'));
		const teach = await html("/src/lib/home/NewSessionPage.svelte", { initialConfigured: true, mode: "teach" });
		assert.ok(!teach.includes('data-testid="practice-props-chip"'));
	});
});

describe("home shell", () => {
	it("empty graph shows the honest empty state and the import entry point", async () => {
		const body = await html("/src/lib/home/HomePage.svelte", { initialConfigured: true });
		assert.match(body, /Knowledge graph/);
		assert.match(body, /Start a session or import notes to build your graph\./);
		assert.ok(body.includes('data-testid="import-notes"'));
	});
});
