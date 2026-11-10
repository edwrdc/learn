import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint({ cwd: process.cwd() });
const file = (relative: string) => path.resolve(relative);

async function lint(relative: string, source: string) {
	const results = await eslint.lintText(source, { filePath: file(relative) });
	const result = results[0]!;
	return { errors: result.errorCount, messages: result.messages.map((message) => message.message) };
}

const svelte = (body: string) => `<script lang="ts">\n\t${body}\n</script>\n\n<p>probe</p>\n`;

describe("feature import rules", () => {
	it("forbids a Svelte component from importing a feature's server surface", async () => {
		const result = await lint("src/lib/probe.svelte", svelte('import { getChat } from "@/src/session";\n\tvoid getChat;'));
		assert.equal(result.errors, 1);
		assert.match(result.messages[0]!, /The UI imports only/);
	});

	it("forbids a UI module from importing a feature internal", async () => {
		const result = await lint("src/lib/probe.ts", 'import { chatStore } from "@/src/session/store.ts";\nvoid chatStore;\n');
		assert.equal(result.errors, 1);
		assert.match(result.messages[0]!, /The UI imports only/);
	});

	it("forbids a client route component from importing a feature's server surface", async () => {
		const result = await lint("src/routes/probe/+page.svelte", svelte('import { getChat } from "@/src/session";\n\tvoid getChat;'));
		assert.equal(result.errors, 1);
		assert.match(result.messages[0]!, /Client route components import only/);
	});

	it("forbids a route from importing a feature internal instead of its index", async () => {
		const result = await lint("src/routes/probe/+page.server.ts", 'import { chatStore } from "@/src/session/store.ts";\nvoid chatStore;\n');
		assert.equal(result.errors, 1);
		assert.match(result.messages[0]!, /Routes import lib/);
	});

	it("keeps model/ folders pure", async () => {
		const result = await lint("src/session/model/probe.ts", 'import { graphStore } from "../../graph/index.ts";\nvoid graphStore;\n');
		assert.equal(result.errors, 1);
		assert.match(result.messages[0]!, /model\/ folders are pure/);
	});

	it("forbids a feature from reaching into another feature's internals", async () => {
		const result = await lint("src/jobs/probe.ts", 'import { chatStore } from "../session/store.ts";\nvoid chatStore;\n');
		assert.equal(result.errors, 1);
		assert.match(result.messages[0]!, /src\/jobs imports src\/session only through/);
	});

	it("forbids feature code from importing the UI", async () => {
		const result = await lint("src/graph/probe.ts", 'import { formatUsd } from "../lib/format.ts";\nvoid formatUsd;\n');
		assert.equal(result.errors, 1);
		assert.match(result.messages[0]!, /Feature code never imports the UI/);
	});

	it("allows the imports the rules name", async () => {
		const cases: Array<[string, string]> = [
			["src/lib/probe.ts", 'import { formatUsd } from "$lib/format";\nvoid formatUsd;\n'],
			["src/lib/ok.svelte", svelte('import { resolveSettings } from "@/src/settings/model";\n\tvoid resolveSettings;')],
			["src/routes/probe/+page.svelte", svelte('import Sidebar from "$lib/shell/Sidebar.svelte";\n\tvoid Sidebar;')],
			["src/routes/ok/+server.ts", 'import { resolveSettings } from "@/src/settings/model";\nimport { getChat } from "@/src/session";\nvoid resolveSettings;\nvoid getChat;\n'],
			["src/jobs/probe.ts", 'import { chatStore } from "../session/index.ts";\nvoid chatStore;\n'],
			["src/session/model/probe.ts", 'import type { GraphNode } from "../../graph/model/index.ts";\nexport type X = GraphNode;\n'],
		];
		for (const [where, source] of cases) {
			const result = await lint(where, source);
			assert.equal(result.errors, 0, `${where}: ${result.messages.join("\n")}`);
		}
	});

	it("ignores the private .agents assets", async () => {
		assert.equal(await eslint.isPathIgnored(".agents/skills/private/SKILL.md"), true);
	});
});
