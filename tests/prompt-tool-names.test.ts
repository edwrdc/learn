import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { toolInfo } from "../src/tools/model/index.ts";

const PROMPTS = path.resolve(import.meta.dirname, "..", "src", "session", "prompts");

/** Backticked words in the prompts that name tool arguments or values, not tools. */
const FIELD_WORDS = new Set(["brief", "check", "confidence", "explanation", "predict", "requires", "thinking", "title", "type"]);

function promptFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		return entry.isDirectory() ? promptFiles(full) : entry.name.endsWith(".md") ? [full] : [];
	});
}

describe("prompt tool names", () => {
	it("every backticked tool name in a prompt is a catalog tool", () => {
		const unknown: string[] = [];
		for (const file of promptFiles(PROMPTS)) {
			for (const [, word] of fs.readFileSync(file, "utf-8").matchAll(/`([a-z_]+)`/g)) {
				if (!FIELD_WORDS.has(word!) && !toolInfo(word!)) unknown.push(`${path.relative(PROMPTS, file)}: ${word}`);
			}
		}
		assert.deepEqual(unknown, []);
	});
});
