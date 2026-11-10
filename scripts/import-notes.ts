/**
 * Import raw notes files through the format-agnostic front door (vision §1,
 * 2026-09-13) — every *.md / *.txt file in a directory becomes one
 * extraction run (extractor → auditor → merger) over its raw text. Run
 * from this worktree only — data never crosses trees:
 *
 *   npx tsx --env-file=.env.local scripts/import-notes.ts <dir>
 *
 * <dir> is required. Runs in this process: the dev server's
 * status chips do NOT see them (registry is per-process) — the dev server
 * sees runs triggered through /api/graph/import.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { getGraph } from "../src/graph/index.ts";
import { boot } from "../src/boot.ts";
import { stores } from "../src/stores.ts";


async function main() {
	const dir = process.argv[2];
	if (!dir) {
		console.error("usage: npx tsx --env-file=.env.local scripts/import-notes.ts <dir>");
		process.exit(1);
	}
	const files = fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".md") || f.endsWith(".markdown") || f.endsWith(".txt"))
		.sort();
	console.log(`[import-notes] ${files.length} note files from ${dir}`);

	const { extraction: pipeline } = boot({ upkeep: false });
	const totals = { nodes: 0, chains: 0, failed: 0 };
	const startedAt: number[] = [];
	await pipeline.importNotesFiles(
		files.map((file, index) => ({
			filePath: path.join(dir, file),
			text: () => {
				startedAt[index] = Date.now();
				return fs.readFileSync(path.join(dir, file), "utf-8");
			},
		})),
		(index, outcome) => {
			const file = files[index];
			if (outcome.status === "rejected") {
				totals.failed++;
				console.error(`[import-notes] ${file} FAILED:`, outcome.reason);
				return;
			}
			const stats = outcome.value;
			totals.nodes += stats.nodes;
			totals.chains += stats.chains;
			console.log(
				`[import-notes] ${file}: ${stats.nodes} nodes, ${stats.chains} chains in ${((Date.now() - startedAt[index]!) / 1000).toFixed(1)}s`,
			);
		},
	);

	const graph = getGraph(stores.graphStore);
	console.log(
		`[import-notes] done: +${totals.nodes} nodes, +${totals.chains} chains, ${totals.failed} failed — ` +
			`graph now ${graph.nodes.length} nodes, ${graph.chains.length} chains`,
	);
}

const invokedAsCli =
	process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsCli) await main();
