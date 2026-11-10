import assert from "node:assert/strict";
import { after, it } from "node:test";
import { POST } from "../src/routes/api/graph/import/+server.ts";
import { routeEvent } from "./support-route-event.ts";
import { boot } from "../src/boot.ts";

const { extraction } = boot({ upkeep: false });
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../src/settings/model/settings.ts";
import { createExtractionPipeline, NotesImportError } from "../src/graph/extraction/pipeline.ts";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { stores } from "../src/stores.ts";
import type { GraphStore } from "../src/graph/model/ports.ts";
import type { EmissionStats, GraphNode, GraphChain, NotesSource, SessionCheckpoint } from "../src/graph/model/types.ts";

const original = extraction.importNotesFiles;
after(() => { extraction.importNotesFiles = original; });
function request(names: string[]) {
	const form = new FormData();
	for (const name of names) form.append("files", new File(["identical text"], name));
	return new Request("http://localhost/api/graph/import", { method: "POST", body: form });
}

it("route keeps request positions and mixed per-file outcomes/config details", async () => {
	const outcomeOf = (filePath: string): PromiseSettledResult<EmissionStats> => {
		if (filePath === "models.md") return { status: "rejected", reason: new ModelsNotConfiguredError(["cheap"]) };
		if (filePath === "key.md") return { status: "rejected", reason: new ProviderKeyMissingError("openai", ["cheap"]) };
		if (["failed", "partial", "aborted", "busy"].includes(filePath)) {
			return { status: "rejected", reason: new NotesImportError(filePath as NotesImportError["outcome"], { nodes: 2, chains: 1 }, `synthetic ${filePath}`) };
		}
		if (filePath === "unknown.md") return { status: "rejected", reason: new Error("synthetic unknown error") };
		return { status: "fulfilled", value: { nodes: 0, chains: 0 } };
	};
	extraction.importNotesFiles = async (files) => files.map((file) => outcomeOf(file.filePath));
	const names = ["slow.md", "same.md", "same.md", "failed", "partial", "aborted", "busy", "models.md", "key.md", "unknown.md"];
	const response = await POST(routeEvent(request(names)));
	assert.equal(response.status, 200);
	const { results } = await response.json();
	assert.equal(results.length, names.length);
	for (const [requestIndex, filePath] of names.entries()) {
		const result = results.find((r: { requestIndex: number }) => r.requestIndex === requestIndex);
		assert.equal(result.filePath, filePath);
		if (["failed", "partial", "aborted", "busy"].includes(filePath)) {
			assert.equal(result.outcome, filePath);
			assert.equal(result.ok, false);
			assert.deepEqual(result.stats, { nodes: 2, chains: 1 });
		} else if (["slow.md", "same.md"].includes(filePath)) {
			assert.equal(result.outcome, "completed"); assert.equal(result.ok, true);
		} else { assert.equal(result.ok, false); assert.equal(result.outcome, "failed"); }
	}
	assert.deepEqual(results.find((r: { filePath: string }) => r.filePath === "models.md").missing, ["cheap"]);
	const key = results.find((r: { filePath: string }) => r.filePath === "key.md");
	assert.equal(key.code, "provider_key_missing"); assert.equal(key.provider, "openai"); assert.deepEqual(key.slots, ["cheap"]);
});

it("real route plus in-memory ledgers and faux stages reprocess identical imports, three files at a time", async () => {
	const nodes: GraphNode[] = [];
	const chains: GraphChain[] = [];
	const checkpoints: SessionCheckpoint[] = [];
	const sources = new Map<string, NotesSource>();
	const graphStore: GraphStore = {
		appendNode: (node) => { nodes.push(node); }, readNodes: () => [...nodes],
		appendChain: (chain) => { chains.push(chain); }, readChains: () => [...chains],
		appendCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); }, readCheckpoints: () => [...checkpoints],
		appendCoverage: () => {}, readCoverage: () => [],
		upsertSource: (source) => { sources.set(source.id, { ...source, extractions: sources.get(source.id)?.extractions ?? [] }); },
		readSources: () => [...sources.values()],
		appendSourceUsage: (id, usage) => { sources.get(id)!.extractions!.push(usage); },
		readPositions: () => ({}), writePositions: () => {}, rewriteLedgers: () => {},
	};
	let calls = 0;
	const pipeline = createExtractionPipeline({ chatStore: stores.chatStore, graphStore,
		engineFor: (role) => {
			const faux = createFauxCore({});
			faux.setResponses([() => {
				if (role === "extractor") calls++;
				return fauxAssistantMessage([fauxToolCall(role === "extractor" ? "submit_findings" : "submit_review", role === "extractor" ? {
					propositions: [{ id: "p1", name: "Synthetic import", statement: "Explicit notes imports process the whole file.", aliases: [] }], chains: [],
				} : { links: [] })], { stopReason: "toolUse" });
			}]);
			return { model: faux.getModel(), streamFn: faux.streamSimple };
		},
	});
	let reading = 0;
	let peak = 0;
	extraction.importNotesFiles = (files, onSettled) =>
		pipeline.importNotesFiles(
			files.map((file) => ({ ...file, text: () => { peak = Math.max(peak, ++reading); return file.text(); } })),
			(index, outcome) => { reading--; onSettled?.(index, outcome); },
		);
	const names = ["1.md", "1.1.md", "1 notes.md", "1.1 notes.md"];
	for (let pass = 0; pass < 2; pass++) {
		const response = await POST(routeEvent(request(names)));
		const { results } = await response.json();
		assert.equal(results.length, 4);
		assert.ok(results.every((r: { ok: boolean; outcome: string }) => r.ok && r.outcome === "completed"));
	}
	assert.equal(peak, 3, "three files run at once");
	assert.equal(calls, 8, "repeat identical imports execute real faux extractor calls");
	assert.equal(nodes.length, 8);
	assert.equal(sources.size, 4);
	assert.ok([...sources.values()].every((source) => source.extractions?.length === 2));
});

it("route returns 400 without files", async () => {
	const response = await POST(routeEvent(request([])));
	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), { results: [], error: "no files" });
});
