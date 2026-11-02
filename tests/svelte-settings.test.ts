/** Svelte ports of the settings-surface SSR pins. */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { KEYBOARD_ACTIONS } from "../src/core/index.ts";
import { closeSvelteSsr, loadSvelteModule, renderSvelte } from "./support-svelte-ssr.ts";

after(closeSvelteSsr);
const html = async (path: string, props: Record<string, unknown> = {}) =>
	(await renderSvelte(path, props)).body.replace(/<!--[^>]*-->/g, "");
function tagOf(body: string, testid: string): string {
	const i = body.indexOf(`data-testid="${testid}"`);
	assert.ok(i >= 0, `missing ${testid}`);
	return body.slice(body.lastIndexOf("<", i), body.indexOf(">", i) + 1);
}

describe("settings dialog", () => {
	it("closed renders nothing", async () => {
		const body = await html("/src/lib/settings/SettingsDialog.svelte");
		assert.equal(body, "");
	});

	it("the dialog frame carries role, close affordance, six nav sections and the loading state", async () => {
		const dialogs = (await loadSvelteModule("/src/lib/state/dialogs.svelte.ts")) as {
			settingsDialog: { open: (section?: string) => void; close: () => void };
		};
		dialogs.settingsDialog.open();
		const body = await html("/src/lib/settings/SettingsDialog.svelte");
		dialogs.settingsDialog.close();
		assert.ok(body.includes('role="dialog"'));
		assert.ok(body.includes('aria-modal="true"'));
		assert.ok(body.includes('aria-label="Close settings"'));
		for (const id of ["general", "keys", "agent", "appearance", "graph", "keyboard"]) {
			assert.ok(body.includes(`data-testid="settings-nav-${id}"`), id);
		}
		assert.ok(tagOf(body, "settings-nav-general").includes('aria-current="true"'));
		assert.ok(tagOf(body, "settings-nav-keyboard").includes('aria-current="false"'));
		assert.ok(body.includes("Loading settings…"));
		assert.ok(!body.includes('href="/settings"'));
	});
});

const agentProps = {
	agent: undefined,
	models: undefined,
	graph: undefined,
	compaction: undefined,
	onSectionChange: () => {},
	onModelsChange: () => {},
	onCompactionChange: () => {},
};
const agent = (over: Record<string, unknown>) => html("/src/lib/settings/AgentSection.svelte", { ...agentProps, ...over });

describe("agent section", () => {
	it("renders the three slot rows with model + thinking triggers and no Default", async () => {
		const body = await agent({});
		for (const slot of ["strong", "cheap", "vision"]) {
			assert.ok(body.includes(`data-testid="slot-row-${slot}"`), slot);
			assert.ok(body.includes(`data-testid="slot-model-${slot}"`), `${slot} model trigger`);
			assert.ok(body.includes(`data-testid="slot-thinking-${slot}"`), `${slot} thinking trigger`);
		}
		assert.ok(body.includes("The main model for your sessions"));
		assert.equal((body.match(/>Default<\/span>/g) ?? []).length, 0);
		assert.ok(!body.includes('data-testid="menu-default"'));
		assert.equal((body.match(/>—<\/span>/g) ?? []).length, 6);
		for (const role of ["researcher", "demoBuilder", "visualMaker"]) assert.ok(!body.includes(`data-testid="role-row-${role}"`));
		assert.ok(body.includes('data-testid="group-models"'));
		assert.ok(body.includes('data-testid="group-tools"'));
		assert.ok(body.includes('data-testid="group-prompts"'));
	});

	it("search engine reads Automatic or the pinned engine", async () => {
		const automatic = await agent({});
		assert.ok(automatic.includes('data-testid="search-engine-row"'));
		assert.ok(automatic.includes('data-testid="search-engine-trigger"'));
		assert.ok(automatic.includes("Automatic"));
		assert.ok((await agent({ agent: { search: { engine: "tavily" } } })).includes("Tavily"));
	});

	it("graph tools lead the Tools group, default on, and dim when the graph is off", async () => {
		const body = await agent({});
		const toolsGroup = body.split('data-testid="group-tools"')[1] ?? "";
		const rows = [...toolsGroup.matchAll(/data-testid="(graph-tools-row|tool-row-\w+)"/g)].map((match) => match[1]);
		assert.equal(rows[0], "graph-tools-row");
		assert.ok(body.includes("Lets the tutor consult your knowledge map between sessions"));
		assert.ok((body.split('data-testid="graph-tools-row"')[1] ?? "").includes('aria-checked="true"'));
		const off = await agent({ graph: { enabled: false } });
		const row = off.split('data-testid="graph-tools-row"')[1]?.split('data-testid="tool-row-')[0] ?? "";
		assert.ok(row.includes("opacity-40"));
		assert.ok(row.includes("Graph is disabled"));
		assert.ok(row.includes("disabled"));
		const storedOff = await agent({ agent: { graphTools: { enabled: false } } });
		assert.ok((storedOff.split('data-testid="graph-tools-row"')[1] ?? "").includes('aria-checked="false"'));
	});

	it("the final tool list renders, defaults on, and carries stored deltas", async () => {
		const body = await agent({});
		for (const id of ["research", "demo", "visual", "pdf"]) assert.ok(body.includes(`data-testid="tool-row-${id}"`), id);
		for (const id of ["research", "demo", "visual", "pdf"]) assert.ok(tagOf(body, `toggle-tool-${id}`).includes('aria-checked="true"'));
		const delta = await agent({ agent: { tools: { demo: false } }, models: { strong: { model: { provider: "zai", id: "glm-4.7-flash" } } } });
		assert.ok(delta.includes("glm-4.7-flash"));
		assert.ok(tagOf(delta, "toggle-tool-demo").includes('aria-checked="false"'));
		assert.ok(tagOf(delta, "toggle-tool-visual").includes('aria-checked="true"'));
	});

	it("prompts show the SSR loading state", async () => {
		assert.ok((await agent({})).includes("Loading prompt segments"));
	});
});

describe("graph section", () => {
	it("extraction + rendering rows default on; dead rungs are gone", async () => {
		const body = await html("/src/lib/settings/GraphSection.svelte", { graph: undefined, onSectionChange: () => {} });
		assert.ok(body.includes('data-testid="graph-row-enabled"'));
		assert.ok(body.includes(">Extraction<"));
		assert.ok(!body.includes("graph-row-embedding"));
		assert.ok(!body.includes("graph-row-clustering"));
		assert.ok(!body.includes("graph-row-labeling"));
		assert.ok(tagOf(body, "toggle-extraction-enabled").includes('aria-checked="true"'));
		assert.ok(tagOf(body, "toggle-graph-rendering-enabled").includes('aria-checked="true"'));
	});

	it("stored off records show off without cross-talk", async () => {
		const extractionOff = await html("/src/lib/settings/GraphSection.svelte", { graph: { enabled: false }, onSectionChange: () => {} });
		assert.ok(tagOf(extractionOff, "toggle-extraction-enabled").includes('aria-checked="false"'));
		const renderingOff = await html("/src/lib/settings/GraphSection.svelte", { graph: { rendering: false }, onSectionChange: () => {} });
		assert.ok(tagOf(renderingOff, "toggle-extraction-enabled").includes('aria-checked="true"'));
		assert.ok(tagOf(renderingOff, "toggle-graph-rendering-enabled").includes('aria-checked="false"'));
	});

	it("chunk budget: unset is empty with the 4096 factory placeholder; stored value rides", async () => {
		const unset = await html("/src/lib/settings/GraphSection.svelte", { graph: undefined, onSectionChange: () => {} });
		const input = tagOf(unset, "input-chunk-tokens");
		assert.ok(input.includes('placeholder="4096"'));
		assert.ok(!/value="\d/.test(input));
		assert.ok(unset.includes(">4096 tok</"));
		const stored = await html("/src/lib/settings/GraphSection.svelte", { graph: { enabled: true, extractionChunkTokens: 6000 }, onSectionChange: () => {} });
		assert.ok(tagOf(stored, "input-chunk-tokens").includes('value="6000"'));
		assert.ok(stored.includes(">6000 tok</"));
	});
});

describe("keys and appearance sections", () => {
	it("keys SSR is the loading state", async () => {
		assert.ok((await html("/src/lib/settings/KeysSection.svelte")).includes("Loading keys…"));
	});

	it("mode is disabled with Coming soon; hex inputs/font trigger/size resolve", async () => {
		const body = await html("/src/lib/settings/AppearanceSection.svelte", { appearance: undefined, onSectionChange: () => {} });
		assert.ok(tagOf(body, "select-mode").includes("disabled"));
		assert.ok(body.includes("Coming soon"));
		assert.ok(tagOf(body, "row-mode").includes("opacity-40"));
		assert.ok(body.includes('placeholder="#141414"'));
		assert.ok(body.includes('data-testid="font-trigger"'));
		assert.equal((body.match(/Empty = same as text/g) ?? []).length, 2);
		assert.ok(body.includes("16px"));
		const set = await html("/src/lib/settings/AppearanceSection.svelte", { appearance: { background: "#1a1a2e" }, onSectionChange: () => {} });
		assert.ok(set.includes('value="#1a1a2e"'));
	});
});

describe("keyboard section", () => {
	it("renders every registry action in its scope and keeps display-only rows fixed", async () => {
		const body = await html("/src/lib/settings/KeyboardSection.svelte");
		for (const def of KEYBOARD_ACTIONS) assert.ok(body.includes(`data-testid="kbd-row-${def.id}"`), def.id);
		assert.ok(body.includes("kbd-scope-global"));
		assert.ok(body.includes("kbd-scope-chat"));
		const openSettings = KEYBOARD_ACTIONS.find((action) => action.id === "open-settings");
		assert.equal(openSettings?.scope, "global");
		assert.equal(openSettings?.binding, "mod+,");
		assert.ok(body.includes("Fixed — part of this screen"));
		assert.ok(!body.includes('data-testid="kbd-rebind-question-next-row"'));
		assert.ok(!body.includes("Model menu"));
	});
});
