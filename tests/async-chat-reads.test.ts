// Set LH_DATA_DIR before app imports so these tests never read real data.
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { routeEvent } from "./support-route-event.ts";
import type { ChatRecord, ExtractionRunUsage } from "../src/core/contracts.ts";
import type { ChatStore } from "../src/core/ports.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-async-chat-reads-"));
process.env.LH_DATA_DIR = TMP;

const { chatStore } = await import("../src/store/chats.ts");
const { closeChatRuntime, openChatRuntime, readEntries } = await import("../src/store/durable.ts");
const { CURRENT_CHAT_VERSION } = await import("../src/core/contracts.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { graphSnapshot, mergeFindings } = await import("../src/core/graph.ts");
const { graphCosts } = await import("../src/server/graph.ts");
const { stores } = await import("../src/server/stores.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { GET } = await import("../src/routes/api/chats/[id]/+server.ts");

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

function chatsDir(): string {
	return path.join(TMP, "chats");
}

function chatFile(id: string): string {
	return path.join(chatsDir(), `${id}.json`);
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function defer<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function writeLegacyRecord(id: string): Buffer {
	const bytes = Buffer.from(
		JSON.stringify(
			{
				id,
				title: `legacy ${id}`,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-02T00:00:00.000Z",
				messages: [newUserMessage(`old words from ${id}`)],
				version: 1,
			},
			null,
			"\t",
		),
	);
	fs.mkdirSync(chatsDir(), { recursive: true });
	fs.writeFileSync(chatFile(id), bytes);
	return bytes;
}

function writeMetaRecord(id: string, title: string, updatedAt: string): void {
	fs.mkdirSync(chatsDir(), { recursive: true });
	fs.writeFileSync(
		chatFile(id),
		JSON.stringify({ id, title, createdAt: "2026-01-01T00:00:00.000Z", updatedAt, version: CURRENT_CHAT_VERSION }, null, "\t"),
	);
}

function fakeRecord(id: string, title: string): ChatRecord {
	return { id, title, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", messages: [] };
}

function usageAt(startedAt: number): ExtractionRunUsage {
	return {
		startedAt,
		at: new Date(startedAt).toISOString(),
		durationMs: 1,
		stages: {
			extractor: { model: "unknown", steps: [] },
			auditor: { model: "unknown", steps: [] },
		},
	};
}

describe("listChats batches record reads", () => {
	it("imports every legacy record once when the first batch opens three at a time", async () => {
		const ids = [
			"chat_batch_legacy_1",
			"chat_batch_legacy_2",
			"chat_batch_legacy_3",
			"chat_batch_legacy_4",
			"chat_batch_legacy_5",
		];
		const backups = new Map(ids.map((id) => [id, writeLegacyRecord(id)]));
		const readdirOrder = fs
			.readdirSync(chatsDir())
			.filter((name) => name.endsWith(".json"))
			.map((name) => name.slice(0, -5));

		const list = await chatStore.listChats();

		const mine = list.filter((entry) => ids.includes(entry.id));
		assert.deepEqual(
			mine.map((entry) => entry.id),
			readdirOrder.filter((id) => ids.includes(id)),
			"equal updatedAt values keep the readdir order",
		);
		assert.equal(mine.length, ids.length, "no legacy record is dropped");
		assert.ok(mine.every((entry) => entry.messageCount === 1), "each legacy transcript is imported");
		for (const id of ids) {
			const runtime = await openChatRuntime(id);
			assert.equal((await readEntries(runtime)).length, 1, `${id}: one durable entry, not one per concurrent importer`);
			assert.deepEqual(fs.readFileSync(path.join(runtime.dir, "legacy-chat.json")), backups.get(id), `${id}: the original bytes are the backup`);
			const meta = JSON.parse(fs.readFileSync(chatFile(id), "utf-8")) as Record<string, unknown>;
			assert.equal(meta.messages, undefined, `${id}: the metadata drops the transcript`);
			assert.equal(meta.version, CURRENT_CHAT_VERSION);
			await closeChatRuntime(id);
		}
	});

	it("keeps updatedAt order across corrupt and current records", async () => {
		writeMetaRecord("chat_batch_new", "Newest", "2026-04-01T00:00:00.000Z");
		writeMetaRecord("chat_batch_tie_a", "Tie A", "2026-03-01T00:00:00.000Z");
		writeMetaRecord("chat_batch_tie_b", "Tie B", "2026-03-01T00:00:00.000Z");
		writeMetaRecord("chat_batch_old", "Oldest", "2026-02-01T00:00:00.000Z");
		fs.writeFileSync(chatFile("chat_batch_corrupt_a"), "{ not json");
		fs.writeFileSync(chatFile("chat_batch_corrupt_b"), "");
		const seeded = ["chat_batch_new", "chat_batch_tie_a", "chat_batch_tie_b", "chat_batch_old"];
		const readdirOrder = fs
			.readdirSync(chatsDir())
			.filter((name) => name.endsWith(".json"))
			.map((name) => name.slice(0, -5));
		const tied = readdirOrder.filter((id) => id === "chat_batch_tie_a" || id === "chat_batch_tie_b");

		const list = await chatStore.listChats();

		assert.deepEqual(
			list.filter((entry) => seeded.includes(entry.id)).map((entry) => entry.id),
			["chat_batch_new", ...tied, "chat_batch_old"],
			"newest first; equal updatedAt keeps insertion order",
		);
		assert.ok(!list.some((entry) => entry.id.startsWith("chat_batch_corrupt")), "a corrupt record never reaches the list");
		assert.equal(list.find((entry) => entry.id === "chat_batch_new")!.messageCount, 0);
	});
});

describe("graphSnapshot batches source-label reads", () => {
	it("keeps three reads in flight and labels sources in source order", async () => {
		const chatIds = ["chat_snap_a", "chat_snap_b", "chat_snap_c"];
		const mergeSource = (id: string, statement: string): void => {
			mergeFindings(
				id,
				{ propositions: [{ id: `p_${id}`, name: statement, statement, aliases: [] }], chains: [] },
				{ links: [] },
				{ chatStore, graphStore },
				{ foldedAt: "2026-10-01T00:00:00.000Z" },
			);
		};
		for (const [index, id] of chatIds.entries()) mergeSource(id, `Snapshot statement ${index + 1}.`);
		graphStore.upsertSource({ id: "src_snap_notes", filePath: "/vault/snapshot notes.md", importedAt: "2026-10-01T00:00:00.000Z" });
		mergeSource("src_snap_notes", "Snapshot notes statement.");
		mergeSource("chat_snap_absent", "Snapshot absent statement.");
		const sourceOrder = [...chatIds, "src_snap_notes", "chat_snap_absent"];

		const gates = new Map<string, Deferred<ChatRecord | null>>();
		const started: string[] = [];
		const firstStart = defer<void>();
		const fourthStart = defer<void>();
		const fakeChatStore: ChatStore = {
			...chatStore,
			getChat: (id) => {
				started.push(id);
				if (started.length === 1) firstStart.resolve();
				if (started.length === 4) fourthStart.resolve();
				const gate = defer<ChatRecord | null>();
				gates.set(id, gate);
				return gate.promise;
			},
		};

		const snapshot = graphSnapshot({ chatStore: fakeChatStore, graphStore });

		await firstStart.promise;
		assert.deepEqual(started, sourceOrder.slice(0, 3), "the first batch opens three source reads");
		gates.get("chat_snap_c")!.resolve(fakeRecord("chat_snap_c", "Snapshot C"));
		gates.get("chat_snap_b")!.resolve(fakeRecord("chat_snap_b", "Snapshot B"));
		gates.get("chat_snap_a")!.resolve(fakeRecord("chat_snap_a", "Snapshot A"));
		await fourthStart.promise;
		assert.deepEqual(started, sourceOrder, "the next batch starts only after the first settles");
		gates.get("src_snap_notes")!.resolve(null);
		gates.get("chat_snap_absent")!.resolve(null);

		const snap = await snapshot;

		assert.deepEqual(Object.keys(snap.sessions), chatIds, "labels land in source order, not completion order");
		assert.deepEqual(chatIds.map((id) => snap.sessions[id]), ["Snapshot A", "Snapshot B", "Snapshot C"]);
		assert.deepEqual(snap.fileSources, { src_snap_notes: "/vault/snapshot notes.md" }, "the notes fallback still labels a non-chat source");
		assert.equal("chat_snap_absent" in snap.sessions, false);
		assert.equal("chat_snap_absent" in snap.fileSources, false);
	});

	it("rejects the whole snapshot when a source read rejects", async () => {
		const boom = new Error("snapshot source read failed");
		mergeFindings(
			"chat_snap_rejection",
			{ propositions: [{ id: "p_chat_snap_rejection", name: "Rejection statement.", statement: "Rejection statement.", aliases: [] }], chains: [] },
			{ links: [] },
			{ chatStore, graphStore },
			{ foldedAt: "2026-10-01T00:00:00.000Z" },
		);
		const fakeChatStore: ChatStore = {
			...chatStore,
			getChat: async (id) => {
				if (id === "chat_snap_rejection") throw boom;
				return null;
			},
		};

		await assert.rejects(graphSnapshot({ chatStore: fakeChatStore, graphStore }), (error) => error === boom);
	});
});

describe("graphCosts batches usage-record reads", () => {
	it("keeps three reads in flight and folds runs in summary order", async () => {
		const created: string[] = [];
		const startedAt = new Map<string, number>();
		const rows: Array<[string, number | null]> = [
			["Cost A", 3000],
			["Cost B", 2000],
			["Cost C", 2000],
			["Cost D", 1000],
			["No usage", null],
		];
		for (const [title, started] of rows) {
			const chat = chatStore.createChat(title);
			created.push(chat.id);
			if (started === null) continue;
			startedAt.set(chat.id, started);
			await chatStore.appendExtractionUsage(chat.id, usageAt(started));
		}
		const summaries = (await chatStore.listChats()).filter((summary) => created.includes(summary.id));
		const records = new Map<string, ChatRecord>();
		for (const summary of summaries) records.set(summary.id, (await chatStore.getChat(summary.id))!);

		const realChatStore = stores.chatStore;
		const gates = new Map<string, Deferred<ChatRecord | null>>();
		const started: string[] = [];
		const firstStart = defer<void>();
		const fourthStart = defer<void>();
		try {
			stores.chatStore = {
				...realChatStore,
				listChats: async () => summaries,
				getChat: (id) => {
					started.push(id);
					if (started.length === 1) firstStart.resolve();
					if (started.length === 4) fourthStart.resolve();
					const gate = defer<ChatRecord | null>();
					gates.set(id, gate);
					return gate.promise;
				},
			};
			const costs = graphCosts();
			await firstStart.promise;

			assert.deepEqual(started, summaries.slice(0, 3).map((summary) => summary.id), "the first batch opens three record reads");
			for (const summary of summaries.slice(0, 3)) gates.get(summary.id)!.resolve(records.get(summary.id)!);
			await fourthStart.promise;
			assert.deepEqual(started, summaries.map((summary) => summary.id), "the next batch starts only after the first settles");
			for (const summary of summaries.slice(3)) gates.get(summary.id)!.resolve(records.get(summary.id)!);

			const folded = await costs;
			const expected = summaries
				.filter((summary) => startedAt.has(summary.id))
				.sort((a, b) => startedAt.get(b.id)! - startedAt.get(a.id)!)
				.map((summary) => records.get(summary.id)!.title);

			assert.deepEqual(folded.runs.map((run) => run.title), expected, "newest first, equal startedAt keeps summary order");
			assert.deepEqual(
				folded.runs.map((run) => run.startedAt),
				summaries
					.filter((summary) => startedAt.has(summary.id))
					.sort((a, b) => startedAt.get(b.id)! - startedAt.get(a.id)!)
					.map((summary) => startedAt.get(summary.id)!),
			);
			assert.equal(folded.stages.extraction.runs, 4, "the run without extractions is not folded");
		} finally {
			stores.chatStore = realChatStore;
		}
	});

	it("rejects the whole cost fold when a record read rejects", async () => {
		const boom = new Error("cost record read failed");
		const chat = chatStore.createChat("Cost rejection fixture");
		const summary = (await chatStore.listChats()).find((entry) => entry.id === chat.id)!;
		const realChatStore = stores.chatStore;
		try {
			stores.chatStore = {
				...realChatStore,
				listChats: async () => [summary],
				getChat: async () => {
					throw boom;
				},
			};
			await assert.rejects(graphCosts(), (error) => error === boom);
		} finally {
			stores.chatStore = realChatStore;
		}
	});
});

describe("GET /api/chats/:id", () => {
	it("404s an unknown chat before any coverage read", async () => {
		const realChatStore = stores.chatStore;
		let coverageReads = 0;
		try {
			stores.chatStore = {
				...realChatStore,
				getChat: async (id) => {
					coverageReads++;
					return realChatStore.getChat(id);
				},
			};
			const res = await GET(routeEvent(new Request("http://x/api/chats/chat_route_missing"), { id: "chat_route_missing" }));

			assert.equal(res.status, 404);
			assert.equal(coverageReads, 0, "the 404 gate runs before the coverage read");
		} finally {
			stores.chatStore = realChatStore;
		}
	});

	it("serves the record, the live turn flag, and coverage in one response", async () => {
		const chat = chatStore.createChat("Route fixture");
		await chatStore.saveMessages(chat.id, [
			newUserMessage("hello"),
			{
				id: "msg_route_assistant",
				role: "assistant",
				content: [{ type: "text", text: "A join combines rows." }],
				timestamp: 2,
				api: "faux",
				provider: "faux",
				model: "faux",
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
			},
		]);
		assert.equal(beginTurn(chat.id), true);
		try {
			const res = await GET(routeEvent(new Request(`http://x/api/chats/${chat.id}`), { id: chat.id }));
			const body = (await res.json()) as Record<string, unknown>;
			const record = (await chatStore.getChat(chat.id))!;

			assert.equal(res.status, 200);
			assert.deepEqual(body.messages, record.messages, "the stored transcript is served verbatim");
			assert.equal(body.turnInFlight, true, "the live turn claim is visible");
			assert.equal(body.compacting, false);
			const coverage = body.coverage as { totalMessages: number } | null;
			assert.notEqual(coverage, null, "the record exists, so coverage is computed");
			assert.equal(coverage!.totalMessages, record.messages.length);
			assert.deepEqual(
				Object.keys(body),
				[...Object.keys(record), "turnInFlight", "compacting", "coverage"],
				"the response keys are unchanged",
			);
		} finally {
			endTurn(chat.id);
			await closeChatRuntime(chat.id);
		}
	});
});
