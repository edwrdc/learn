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

describe("import boundary law", () => {
	it("forbids a Svelte component from importing the server layer", async () => {
		const result = await lint(
			"src/lib/probe.svelte",
			'<script lang="ts">\n\timport { getChat } from "@/src/server";\n\tvoid getChat;\n</script>\n\n<p>probe</p>\n',
		);
		assert.equal(result.errors, 1);
		assert.match(result.messages[0]!, /Browser shell imports ONLY/);
	});

	it("forbids a Svelte module from importing the server layer", async () => {
		const result = await lint(
			"src/lib/probe.ts",
			'import { getChat } from "@/src/server";\nvoid getChat;\n',
		);
		assert.equal(result.errors, 1);
		assert.match(result.messages[0]!, /Browser shell imports ONLY/);
	});

	it("forbids a route module from importing a store adapter instead of the barrel", async () => {
		const result = await lint(
			"src/routes/probe/+page.server.ts",
			'import { chatStore } from "@/src/store/chats.ts";\nvoid chatStore;\n',
		);
		assert.equal(result.errors, 1);
		assert.match(result.messages[0]!, /src\/routes \(transport \+ server loads\) imports ONLY/);
	});

	it("keeps the pure core free of IO layers", async () => {
		const result = await lint(
			"src/core/probe.ts",
			'import { getChat } from "@/src/server/index.ts";\nvoid getChat;\n',
		);
		assert.equal(result.errors, 1);
		assert.match(result.messages[0]!, /Pure core never imports IO layers/);
	});

	it("keeps the agent layer free of the server/store layers", async () => {
		const result = await lint(
			"src/agent/probe.ts",
			'import { chatStore } from "@/src/store/chats.ts";\nvoid chatStore;\n',
		);
		assert.equal(result.errors, 1);
		assert.match(result.messages[0]!, /agent layer receives its dependencies/);
	});

	it("forbids core internals from a Svelte module even though the barrel is allowed", async () => {
		const result = await lint(
			"src/lib/probe.ts",
			'import { buildGraph } from "@/src/core/graph.ts";\nvoid buildGraph;\n',
		);
		assert.equal(result.errors, 1);
		assert.match(result.messages[0]!, /Browser shell imports ONLY/);
	});

	it("allows a lib module to import a sibling lib module", async () => {
		const result = await lint(
			"src/lib/probe.ts",
			'import { formatUsd } from "$lib/format";\nvoid formatUsd;\n',
		);
		assert.equal(result.errors, 0, result.messages.join("\n"));
	});

	it("forbids a client route component from importing the server barrel", async () => {
		const result = await lint(
			"src/routes/probe/+page.svelte",
			'<script lang="ts">\n\timport { getChat } from "@/src/server";\n\tvoid getChat;\n</script>\n\n<p>probe</p>\n',
		);
		assert.equal(result.errors, 1);
		assert.match(result.messages[0]!, /Client route components never import the server layer/);
	});

	it("allows a client route component to import $lib components", async () => {
		const result = await lint(
			"src/routes/probe/+page.svelte",
			'<script lang="ts">\n\timport Sidebar from "$lib/shell/Sidebar.svelte";\n\tvoid Sidebar;\n</script>\n\n<p>probe</p>\n',
		);
		assert.equal(result.errors, 0, result.messages.join("\n"));
	});

	it("forbids a server load from importing a server internal instead of the barrel", async () => {
		const result = await lint(
			"src/routes/probe/+page.server.ts",
			'import { chatStore } from "@/src/server/chats.ts";\nvoid chatStore;\n',
		);
		assert.equal(result.errors, 1);
		assert.match(result.messages[0]!, /src\/routes \(transport \+ server loads\) imports ONLY/);
	});

	it("ignores the private .agents assets", async () => {
		assert.equal(await eslint.isPathIgnored(".agents/skills/private/SKILL.md"), true);
	});

	it("ignores a previous Next build left in the workspace", async () => {
		assert.equal(await eslint.isPathIgnored(".next/server/chunks/stale.js"), true);
	});

	it("still allows the barrels the law names", async () => {
		const component = await lint(
			"src/lib/ok.svelte",
			'<script lang="ts">\n\timport { resolveSettings } from "@/src/core";\n\tvoid resolveSettings;\n</script>\n\n<p>ok</p>\n',
		);
		assert.equal(component.errors, 0, component.messages.join("\n"));
		const route = await lint(
			"src/routes/ok/+server.ts",
			'import { resolveSettings } from "@/src/core";\nimport { getChat } from "@/src/server";\nvoid resolveSettings;\nvoid getChat;\nexport function GET() { return new Response("ok"); }\n',
		);
		assert.equal(route.errors, 0, route.messages.join("\n"));
	});
});
