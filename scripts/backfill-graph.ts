/**
 * One-time backfill: wipe the legacy ledgers and re-extract every chat with
 * the redesigned pipeline (vision §1, commit b07c907). Run from the master
 * tree only — data never crosses trees:
 *
 *   npx tsx --env-file=.env.local scripts/backfill-graph.ts
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { chatStore } from "../src/session/store.ts";
import { graphStore } from "../src/graph/store.ts";
import { getGraph } from "../src/graph/snapshot.ts";
import { boot } from "../src/boot.ts";


async function main() {
	const only = process.argv[2]; // optional: extract just one chat id
	const all = await chatStore.listChats();
	const chats = only ? all.filter((c) => c.id === only) : all;
	console.log(`[backfill] ${chats.length} chats to extract`);
	const { extraction: pipeline } = boot();
	for (const chat of chats) {
		const t0 = Date.now();
		try {
			const stats = await pipeline.runExtraction(chat.id);
			console.log(
				`[backfill] ${chat.id} (${chat.title.slice(0, 40)}): ` +
					`${stats.nodes} nodes, ${stats.chains ?? 0} chains in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
			);
		} catch (err) {
			console.error(`[backfill] ${chat.id} FAILED:`, err);
		}
	}
	const graph = getGraph(graphStore);
	console.log(
		`[backfill] done: ${graph.nodes.length} nodes, ${graph.chains.length} chains`,
	);
}

const invokedAsCli =
	process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsCli) await main();
