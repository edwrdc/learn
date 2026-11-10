// Set LH_DATA_DIR before app imports so these tests never read real data.
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { routeEvent } from "./support-route-event.ts";
import type { ChatRecord, ExtractionRunUsage } from "../src/session/model/types.ts";
import type { ChatStore } from "../src/session/model/ports.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-async-chat-reads-"));
process.env.LH_DATA_DIR = TMP;

const { chatStore } = await import("../src/session/store.ts");
const { closeChatRuntime } = await import("../src/session/durable.ts");
const { CURRENT_CHAT_VERSION } = await import("../src/session/model/types.ts");
const { newUserMessage } = await import("../src/session/model/transcript.ts");
const { graphStore } = await import("../src/graph/store.ts");
const { graphSnapshot, mergeFindings } = await import("../src/graph/snapshot.ts");
const { graphCosts } = await import("../src/graph/service.ts");
const { stores } = await import("../src/stores.ts");
const { beginTurn, endTurn } = await import("../src/session/turn-liveness.ts");
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

describe("graphSnapshot source labels", () => {
	it("labels chat sources in source order and falls back to notes paths", async () => {
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

		const titles: Record<string, string> = { chat_snap_a: "Snapshot A", chat_snap_b: "Snapshot B", chat_snap_c: "Snapshot C" };
		const fakeChatStore: ChatStore = {
			...chatStore,
			getChats: async (ids) => ids.map((id) => (titles[id] ? fakeRecord(id, titles[id]) : null)),
		};

		const snapshot = graphSnapshot({ chatStore: fakeChatStore, graphStore });
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
			getChats: async (ids) => {
				if (ids.includes("chat_snap_rejection")) throw boom;
				return ids.map(() => null);
			},
		};

		await assert.rejects(graphSnapshot({ chatStore: fakeChatStore, graphStore }), (error) => error === boom);
	});
});

describe("graphCosts", () => {
	it("folds runs newest first, in summary order on ties", async () => {
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
		try {
			stores.chatStore = {
				...realChatStore,
				listChats: async () => summaries,
				getChats: async (ids) => ids.map((id) => records.get(id) ?? null),
			};
			const costs = graphCosts();
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
				getChats: async () => {
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
