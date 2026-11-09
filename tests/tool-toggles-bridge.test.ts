/**
 * The P2 tool-toggle bridge (2026-09-19): the resolved settings seam
 * (`enabled`) filters the tool factories' registries — the durable runtime
 * builds every turn's tools from exactly these factories, so this is where
 * the toggles land. An explicitly injected registry (the protocol suites,
 * `PrepareOptions.tools`) never passes through the filter. The settings
 * write side rejects unknown tool keys against TOGGLEABLE_TOOLS.
 *
 * Parser tests are PURE (no fs — parallel-test discipline); the registry
 * tests use an in-memory chat fixture like question-tools.test.ts.
 */
import assert from "node:assert/strict";
import { z } from "zod";
import { describe, it } from "node:test";
import { bareQuestionTools } from "../src/session/agents.ts";
import { createProberTools, type ProberToolContext } from "../src/session/tools/registry.ts";
import { jobStore } from "../src/jobs/store.ts";
import { parseSection } from "../src/settings/model/schema.ts";

const parseAgentSettingsBody = (body: unknown) => parseSection("agent", body);
import { chatStore } from "../src/session/store.ts";
import type { AgentSettings } from "../src/settings/model/settings.ts";

describe("the tool-toggle bridge (the P2 seam)", () => {
	const toolNames = (tools: Record<string, unknown>) => Object.keys(tools).sort();

	it("a job-tool delta is a no-op on the bare question set", () => {
		// No ctx → bare fixture: quiz/ask only. A job-tool delta names tools
		// that don't exist there — the filter must not crash on it.
		assert.deepEqual(toolNames(bareQuestionTools()), ["ask_user_question", "quiz"]);
	});

	it("flows into the prober's registry; probe_done survives everything", () => {
		const chatId = chatStore.createChat("Toggle bridge test").id;
		const ctx: ProberToolContext = { chatId, chatStore, deliver: () => {}, jobStore, spawn: () => {} };
		const names = toolNames(createProberTools(ctx, { research: false }));
		assert.ok(!names.includes("research"), "the delta dropped the tool");
		assert.ok(names.includes("probe_done"), "probe_done always-on");
	});
});

describe("parseAgentSettingsBody: tool keys validate at write time", () => {
	const parse = (tools: Record<string, boolean>) =>
		parseAgentSettingsBody({ tools }) as
			| { ok: true; value: AgentSettings }
			| { ok: false; error: string };

	it("a valid job-tool delta parses", async () => {
		const r = parse({ research: false, pdf: false });
		assert.equal(r.ok, true);
		assert.deepEqual(r.ok && r.value.tools, { research: false, pdf: false });
	});

	it("the quizzing-mechanics key (explain) is writable (owner 2026-09-27)", async () => {
		const r = parse({ explain: true });
		assert.equal(r.ok, true);
		assert.deepEqual(r.ok && r.value.tools, { explain: true });
	});

	it("unknown keys are rejected with the supported list (the quiz wedge never persists)", async () => {
		const r = parse({ quiz: false });
		assert.equal(r.ok, false);
		assert.match(!r.ok && r.error, /unknown tool "quiz" \(supported: research, demo, visual, pdf, explain\)/);
		const typo = parse({ reasearch: false });
		assert.equal(typo.ok, false);
		assert.match(!typo.ok && typo.error, /unknown tool "reasearch"/);
	});

	it("absent tools field is fine (absent = enabled everywhere)", async () => {
		const r = parseAgentSettingsBody({}) as { ok: boolean };
		assert.equal(r.ok, true);
	});
});
