/** Svelte ports of the delete dialogs, coverage/activity pure folds, font
 *  menu, and notes-import transport contracts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, describe, it } from "node:test";
import { deleteFailureLine, EXTRACTION_RETRY_LINE } from "../src/lib/home/delete-node.ts";
import { ringFill } from "../src/lib/chat/coverage.ts";
import { formatElapsed, toBlobs } from "../src/lib/state/activity.ts";
import type { ActivityExtraction, ActivityFeed } from "../src/jobs/model/index.ts";
import { formatTokens, formatUsd } from "../src/lib/format.ts";
import { composeFontFamily, CURATED_FALLBACK_FONTS, customFamilyFor, DEFAULT_READING_FONT, fontMenuResults } from "../src/lib/settings/fonts.ts";
import { notesImportErrors, parseNotesImportResults, postNotesImport } from "../src/lib/home/notes-import.ts";
import type { NotesImportResult } from "../src/graph/model/index.ts";
import { closeSvelteSsr, renderSvelte } from "./support-svelte-ssr.ts";

after(closeSvelteSsr);
const html = async (path: string, props: Record<string, unknown> = {}) =>
	(await renderSvelte(path, props)).body.replace(/<!--[^>]*-->/g, "");

describe("delete node dialog", () => {
	const bodyAt = (nodes: { id: string; name: string }[]) => html("/src/lib/home/DeleteNodeDialog.svelte", { nodes, onClose: () => {}, onDeleted: () => {} });

	it("null and empty nodes render nothing", async () => {
		assert.equal(await html("/src/lib/home/DeleteNodeDialog.svelte", { nodes: null, onClose: () => {}, onDeleted: () => {} }), "");
		assert.equal(await html("/src/lib/home/DeleteNodeDialog.svelte", { nodes: [], onClose: () => {}, onDeleted: () => {} }), "");
	});

	it("single: red title, mono name, one permanence line, destructive confirm", async () => {
		const body = await bodyAt([{ id: "kepler", name: "Kepler's three laws" }]);
		assert.ok(body.includes('data-testid="delete-node-dialog"'));
		assert.match(body, /Delete node\?/);
		assert.match(body.match(/<h2[^>]*>/)?.[0] ?? "", /text-sm font-semibold text-destructive/);
		const name = body.match(/data-testid="node-name-code"[^>]*>/)?.[0] ?? "";
		assert.match(name, /font-mono text-sm/);
		assert.ok(!name.includes("bg-muted"));
		assert.match(body, /Kepler('|&#x27;)s three laws/);
		assert.match(body, /This permanently deletes the node — this cannot be undone\./);
		assert.match(body, /border-destructive\/50[^>]*text-destructive/);
	});

	it("no pre-flight impact facts, loading line or sessions join", async () => {
		const body = await bodyAt([{ id: "kepler", name: "Kepler's three laws" }]);
		for (const dead of ["node-impact-facts", "node-impact-loading", "Reading what this would remove", "Referenced by", "links to other topics"]) {
			assert.ok(!body.includes(dead), dead);
		}
	});

	it("multi: plural title, first eight names + and-K-more, plural permanence", async () => {
		const three = await bodyAt([
			{ id: "kepler", name: "Kepler's three laws" },
			{ id: "newton", name: "Newton's second law" },
			{ id: "hook", name: "Hooke's law" },
		]);
		assert.match(three, /Delete 3 nodes\?/);
		assert.match(three, /Kepler('|&#x27;)s three laws, Newton('|&#x27;)s second law, Hooke('|&#x27;)s law/);
		assert.ok(!three.includes('data-testid="node-name-code"'));
		assert.match(three, /This permanently deletes all 3 nodes — this cannot be undone\./);
		const ten = await bodyAt(Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, name: `Prop ${i}` })));
		assert.match(ten, /Delete 10 nodes\?/);
		assert.match(ten, /Prop 7/);
		assert.match(ten, /, and 2 more/);
	});

	it("the 409 copy names the activity dock and replaces the raw line", () => {
		assert.equal(EXTRACTION_RETRY_LINE, "An extraction is running — try again when the activity dock drains.");
		assert.equal(deleteFailureLine({ code: "extraction_running", error: "server line" }), EXTRACTION_RETRY_LINE);
		assert.equal(deleteFailureLine({ code: "not_found", error: "No such node" }), "No such node");
	});
});

describe("delete session dialog", () => {
	it("closed renders nothing", async () => {
		assert.equal(await html("/src/lib/shell/DeleteSessionDialog.svelte", { chat: null, onClose: () => {}, onDeleted: () => {} }), "");
	});

	it("open: red title, mono name, one unchecked traces checkbox with its consequence", async () => {
		const body = await html("/src/lib/shell/DeleteSessionDialog.svelte", {
			chat: { id: "c1", title: "Orbital mechanics" },
			onClose: () => {},
			onDeleted: () => {},
		});
		assert.match(body, /Delete session\?/);
		assert.match(body.match(/<h2[^>]*>/)?.[0] ?? "", /text-sm font-semibold text-destructive/);
		assert.match(body, /data-testid="session-name-code"[^>]*>Orbital mechanics</);
		assert.ok(!/"checked"/.test(body), "unchecked by default");
		assert.ok(body.includes("Also remove its graph traces"));
		assert.ok(body.includes("leave the graph too"));
		assert.ok(body.includes("survive"));
		assert.ok(!body.includes("delete-option-preserve"));
		assert.ok(!body.includes("delete-option-nodes"));
	});

	it("bottom row: quiet Cancel + destructive Delete", async () => {
		const body = await html("/src/lib/shell/DeleteSessionDialog.svelte", {
			chat: { id: "c1", title: "Orbital mechanics" },
			onClose: () => {},
			onDeleted: () => {},
		});
		assert.match(body, /data-testid="delete-cancel"[^>]*>Cancel</);
		assert.match(body.match(/data-testid="delete-confirm"[^>]*>/)?.[0] ?? "", /border-destructive\/50/);
		assert.match(body, /data-testid="delete-confirm"[^>]*>Delete</);
	});
});

describe("extraction coverage pure folds", () => {
	it("ringFill clamps to [0,1] and treats a non-positive threshold as zero", () => {
		assert.equal(ringFill(0, 4096), 0);
		assert.equal(ringFill(2048, 4096), 0.5);
		assert.equal(ringFill(4096, 4096), 1);
		assert.equal(ringFill(999_999, 4096), 1);
		assert.equal(ringFill(2048, 0), 0);
		assert.equal(ringFill(2048, -5), 0);
	});
});

describe("activity feed pure folds", () => {
	const NOW = Date.parse("2026-09-09T12:00:00Z");
	const step = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined });
	const job = (over: Partial<ActivityFeed["jobs"][number]> = {}): ActivityFeed["jobs"][number] => ({
		id: "job-1",
		kind: "research",
		chatId: "c1",
		toolCallId: "t1",
		status: "running",
		activity: 'web_search: "sigma.js v3"',
		createdAt: new Date(NOW - 45_000).toISOString(),
		updatedAt: new Date(NOW - 1000).toISOString(),
		title: "Limits lesson",
		contextLimit: null,
		...over,
	});

	it("merges jobs + extractions oldest-first", () => {
		const blobs = toBlobs({
			jobs: [job({ id: "new", createdAt: new Date(NOW - 10_000).toISOString() })],
			extractions: [{ id: "cx", chatId: "cx", title: "Old lesson", phase: "auditing", startedAt: NOW - 100_000 }],
		});
		assert.deepEqual(blobs.map((b) => [b.id, b.process, b.phase]), [["cx", "extraction", "auditing"], ["new", "job", undefined]]);
	});

	it("per-chunk rows keep unique ids and one chatId", () => {
		const rows = [
			{ id: "src_a#1", chatId: "src_a", part: { i: 1, n: 2 }, title: "notes.md · 1/2", phase: "extracting", startedAt: NOW - 1000 },
			{ id: "src_a#2", chatId: "src_a", part: { i: 2, n: 2 }, title: "notes.md · 2/2", phase: "queued", startedAt: NOW - 500 },
		] as ActivityExtraction[];
		const blobs = toBlobs({ jobs: [], extractions: rows });
		assert.deepEqual(blobs.map((b) => b.id), ["src_a#1", "src_a#2"]);
		assert.ok(blobs.every((b) => b.chatId === "src_a"));
	});

	it("prices jobs, leaves absent usage null, and reads refusals as info", () => {
		const priced = job({ usage: { model: "openrouter:z-ai/glm-5.3-flash", inputTokens: 10_000, outputTokens: 1000, cacheReadTokens: 5000, cacheWriteTokens: 0, reasoningTokens: 0, steps: 2 } });
		const blob = toBlobs({ jobs: [priced], extractions: [] })[0]!;
		assert.ok(blob.cost !== null && blob.cost > 0.0013 && blob.cost < 0.0015);
		assert.equal(toBlobs({ jobs: [job()], extractions: [] })[0]!.cost, null);
		assert.equal(toBlobs({ jobs: [job({ status: "error", error: "No OpenRouter key is set — add one in Settings → Keys", refusal: "provider_key_missing" })], extractions: [] })[0]!.activity, "needs a provider key");
		assert.equal(toBlobs({ jobs: [job({ status: "error", error: "No model configured — set up your models first (missing: vision)", refusal: "models_not_configured" })], extractions: [] })[0]!.activity, "needs model setup");
		assert.equal(toBlobs({ jobs: [job({ status: "error", error: "FAILED: headless crashed" })], extractions: [] })[0]!.activity, 'web_search: "sigma.js v3"');
	});

	it("context is the last step incl. cache, never a cumulative sum", () => {
		const base = { model: "openrouter:z-ai/glm-5.3-flash", inputTokens: 400_000, outputTokens: 8_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, steps: 5 };
		const context = (usage: Record<string, unknown>, limit: number | null = 131_072) =>
			toBlobs({ jobs: [job({ usage: usage as never, contextLimit: limit })], extractions: [] })[0]!.context;
		assert.deepEqual(context({ ...base, lastStep: step(90_000, 2_000) }), { used: 92_000, limit: 131_072 });
		assert.equal(context({ ...base }), null);
		assert.equal(context({ ...base, model: "nope/unknown", lastStep: step(5, 5) }, null), null);
		assert.deepEqual(
			context({ ...base, lastStep: { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 120_000, cacheWriteTokens: 30_000 } }, 200_000),
			{ used: 160_500, limit: 200_000 },
		);
	});

	it("extractions carry no money/context; elapsed and formatting stay compact", () => {
		const blob = toBlobs({ jobs: [], extractions: [{ id: "cx", chatId: "cx", title: "T", phase: "extracting", startedAt: NOW }] })[0]!;
		assert.equal(blob.cost, null);
		assert.equal(blob.context, null);
		assert.equal(formatElapsed(45_000), "45s");
		assert.equal(formatElapsed(184_000), "3m 04s");
		assert.equal(formatElapsed(4_320_000), "1h 12m");
		assert.equal(formatUsd(0.0014), "$0.0014");
		assert.equal(formatUsd(1.5), "$1.50");
		assert.equal(formatTokens(38_000), "38k");
		assert.equal(formatTokens(1_234_567), "1.2M");
		assert.equal(formatTokens(950), "950");
	});
});

describe("font menu", () => {
	const families = ["Arial", "CMU Serif", "Georgia", "Helvetica Neue", "Menlo"];

	it("the default row is a fuzzy candidate, never a ghost pick", () => {
		assert.deepEqual(fontMenuResults("", families), [null, "Arial", "CMU Serif", "Georgia", "Helvetica Neue", "Menlo"]);
		assert.deepEqual(fontMenuResults("georgia", families), ["Georgia"]);
		assert.deepEqual(fontMenuResults("menlo", families), ["Menlo"]);
		assert.equal(fontMenuResults("source", families)[0], null);
		assert.ok(fontMenuResults("default", families).includes(null));
		assert.ok(!fontMenuResults("georgia", families).includes(null));
		assert.deepEqual(fontMenuResults("zzzz", families), []);
	});

	it("composeFontFamily null/blank = factory, otherwise trimmed verbatim", () => {
		assert.equal(composeFontFamily({ background: "#101010" }, null).fontFamily, null);
		assert.equal(composeFontFamily(undefined, "  ").fontFamily, null);
		assert.equal(composeFontFamily(undefined, " Georgia ").fontFamily, "Georgia");
		assert.equal(composeFontFamily({ background: "#101010" }, "Menlo").background, "#101010");
	});

	it("curated fallback includes the app fonts but never the factory row", () => {
		assert.ok(CURATED_FALLBACK_FONTS.includes("CMU Serif"));
		assert.ok(CURATED_FALLBACK_FONTS.includes("Georgia"));
		assert.ok(!CURATED_FALLBACK_FONTS.includes(DEFAULT_READING_FONT));
	});

	it("customFamilyFor only fires when nothing matches", () => {
		assert.equal(customFamilyFor("Baskerville", families), "Baskerville");
		assert.equal(customFamilyFor("  zzz  ", families), "zzz");
		assert.equal(customFamilyFor("georgia", families), null);
		assert.equal(customFamilyFor("source", families), null);
		assert.equal(customFamilyFor("", families), null);
		assert.equal(customFamilyFor("   ", families), null);
	});

	it("FontMenuList SSR: default row, families, one search field, no custom input", async () => {
		const body = await html("/src/lib/settings/FontMenuList.svelte", { families: ["Georgia", "Menlo"], effectiveFamily: null, onPick: () => {} });
		assert.ok(body.includes('data-testid="font-option-default"'));
		assert.ok(body.includes("default</span>"));
		assert.ok(body.includes('data-testid="font-option-Georgia"'));
		assert.ok(body.includes('data-testid="font-option-Menlo"'));
		assert.ok(body.includes('data-testid="font-search"'));
		assert.ok(!body.includes('data-testid="font-custom-input"'));
		assert.ok(!body.includes('data-testid="font-custom-set"'));
		assert.ok(!body.includes("Type a family name"));
		assert.ok(body.includes("Search fonts…"));
	});

	it("effective family highlights exactly its row; unset highlights default", async () => {
		const unset = await html("/src/lib/settings/FontMenuList.svelte", { families: ["Georgia", "Menlo"], effectiveFamily: null, onPick: () => {} });
		assert.ok((unset.split('data-testid="font-option-default"')[1]?.split("</button>")[0] ?? "").includes("bg-muted/60"));
		const menlo = await html("/src/lib/settings/FontMenuList.svelte", { families: ["Georgia", "Menlo"], effectiveFamily: "Menlo", onPick: () => {} });
		assert.ok((menlo.split('data-testid="font-option-Menlo"')[1]?.split("</button>")[0] ?? "").includes("bg-muted/60"));
		assert.ok(!(menlo.split('data-testid="font-option-Georgia"')[1]?.split("</button>")[0] ?? "").includes("bg-muted/60"));
	});

	it("undefined families is the enumerating state", async () => {
		const body = await html("/src/lib/settings/FontMenuList.svelte", { families: undefined, effectiveFamily: null, onPick: () => {} });
		assert.ok(body.includes("Loading fonts…"));
	});

	it("the appearance trigger shows the factory or the stored family", async () => {
		const unset = await html("/src/lib/settings/AppearanceSection.svelte", { appearance: undefined, onSectionChange: () => {} });
		assert.ok(unset.includes('data-testid="font-trigger"'));
		assert.ok(unset.includes(DEFAULT_READING_FONT));
		assert.ok(unset.includes('aria-expanded="false"'));
		assert.ok(!unset.includes('data-testid="input-font"'));
		assert.ok(!unset.includes('placeholder="Source Sans 3"'));
		assert.equal((unset.match(/Empty = same as text/g) ?? []).length, 2);
		assert.ok(!unset.includes("#ee928c") && !unset.includes("#6fa9d6"));
		const stored = await html("/src/lib/settings/AppearanceSection.svelte", { appearance: { fontFamily: "Georgia" }, onSectionChange: () => {} });
		assert.ok(stored.includes("Georgia"));
	});

	it("globals.css keeps the ink tokens at the regular text color", () => {
		const css = fs.readFileSync("src/lib/styles/globals.css", "utf-8");
		assert.ok(!css.includes("--lh-ink-strong: #ee928c"));
		assert.ok(!css.includes("--lh-ink-italic: #6fa9d6"));
		assert.equal((css.match(/--lh-ink-strong: var\(--foreground\)/g) ?? []).length, 2);
		assert.equal((css.match(/--lh-ink-italic: var\(--foreground\)/g) ?? []).length, 2);
	});
});

describe("notes import transport", () => {
	const files = [new File(["one"], "same.md"), new File(["two"], "same.md")];
	const completed = (requestIndex = 0): NotesImportResult => ({ requestIndex, filePath: "same.md", ok: true, outcome: "completed", stats: { nodes: 0, chains: 0 } });

	it("maps out-of-order responses by index, not basename", () => {
		const results = [completed(1), { ...completed(0), stats: { nodes: 7, chains: 0 } }];
		assert.deepEqual(parseNotesImportResults({ results }, files), results);
	});

	for (const [name, results] of [
		["missing index", [{ ...completed(), requestIndex: undefined }, completed(1)]],
		["duplicate index", [completed(), completed()]],
		["missing row", [completed()]],
		["out-of-range index", [completed(), completed(2)]],
		["wrong filename", [{ ...completed(), filePath: "different.md" }, completed(1)]],
		["missing stats", [{ ...completed(), stats: undefined }, completed(1)]],
		["unknown outcome", [{ ...completed(), outcome: "unchanged" }, completed(1)]],
		["conflicting ok", [{ ...completed(), ok: false }, completed(1)]],
		["invalid stats", [{ ...completed(), stats: { nodes: "bad" } }, completed(1)]],
		["invalid details", [{ ...completed(), slots: [42] }, completed(1)]],
		["invalid provider", [{ ...completed(), provider: 42 }, completed(1)]],
		["invalid code", [{ ...completed(), code: 42 }, completed(1)]],
		["invalid missing", [{ ...completed(), missing: [42] }, completed(1)]],
		["invalid error", [{ ...completed(), error: 42 }, completed(1)]],
		["missing failure error", [{ ...completed(), ok: false, outcome: "failed" }, completed(1)]],
	] as const)
		it(`malformed response (${name}) is rejected for retry`, () => {
			assert.throws(() => parseNotesImportResults({ results }, files), /Please retry/);
		});

	it("POST sends only captured files and retains config/provider details", async () => {
		const refused: NotesImportResult = { requestIndex: 0, filePath: files[1]!.name, ok: false, outcome: "failed", code: "provider_key_missing", provider: "openai", slots: ["cheap"], error: "No key is set" };
		const real = globalThis.fetch;
		globalThis.fetch = (async (url, init) => {
			assert.equal(url, "/api/graph/import");
			assert.equal(init?.method, "POST");
			const sent = (init?.body as FormData).getAll("files") as File[];
			assert.equal(sent.length, 1);
			assert.equal(await sent[0]!.text(), "two");
			return Response.json({ results: [refused] });
		}) as typeof fetch;
		try {
			assert.deepEqual(await postNotesImport([files[1]!]), [refused]);
		} finally {
			globalThis.fetch = real;
		}
	});

	for (const kind of ["network", "non-JSON", "non-2xx", "malformed"] as const)
		it(`${kind} rejects rather than false success`, async () => {
			const real = globalThis.fetch;
			globalThis.fetch = (async () => {
				if (kind === "network") throw new Error("synthetic offline");
				if (kind === "non-JSON") return new Response("not JSON");
				if (kind === "non-2xx") return Response.json({ error: "synthetic refused" }, { status: 503 });
				return Response.json({ results: [] });
			}) as typeof fetch;
			try {
				await assert.rejects(postNotesImport([files[0]!]));
			} finally {
				globalThis.fetch = real;
			}
		});

	it("projects failures in selection order with the code/provider/slots suffix", () => {
		const results: NotesImportResult[] = [
			{ requestIndex: 2, filePath: "same.md", ok: false, outcome: "partial", error: "second duplicate" },
			{ ...completed(), filePath: "success.md" },
			{ requestIndex: 1, filePath: "same.md", ok: false, outcome: "failed", error: "first duplicate" },
		];
		assert.deepEqual(notesImportErrors(results), ["same.md: first duplicate", "same.md: second duplicate"]);
		const detailed: NotesImportResult = { ...completed(), ok: false, outcome: "failed", error: "No key", code: "provider_key_missing", provider: "openai", missing: ["OPENAI_API_KEY"], slots: ["cheap", "strong"] };
		assert.deepEqual(notesImportErrors([detailed]), ["same.md: No key\nprovider_key_missing — openai — OPENAI_API_KEY — cheap, strong"]);
	});
});
