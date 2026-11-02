import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escAbortTarget, initialPromptOwed, parseModelsRefusal, parseProviderKeyRefusal } from "../src/lib/chat/chat-logic.ts";
import { buildDemoSrcDoc, DEMO_BRIDGE_SCRIPT, INITIAL_DEMO_BRIDGE_STATE, reduceDemoBridgeState } from "../src/lib/artifacts/demo-bridge.ts";
import { confidenceRailStyle, CONFIDENCE_COLORS } from "../src/lib/chat/confidence.ts";
import { formatTokens, formatUsd, prettyModel, timeAgo } from "../src/lib/format.ts";
import { hintText } from "../src/lib/hint.ts";
import { escapeHtml, lineSpans } from "../src/lib/markdown/copy.ts";

describe("chat logic", () => {
	it("the ?prompt first send is owed unless a real conversation message exists", () => {
		assert.equal(initialPromptOwed([], "hi"), true);
		assert.equal(initialPromptOwed([{ role: "custom" }], "hi"), true);
		assert.equal(initialPromptOwed([{ role: "user" }], "hi"), false);
		assert.equal(initialPromptOwed([], undefined), false);
	});

	it("Esc layers overlays before a question, problem or turn", () => {
		const base = { abortAsk: false, mermaidFocus: false, planOpen: false, setupOpen: false, pending: false, problem: false, busy: false };
		assert.equal(escAbortTarget({ ...base, mermaidFocus: true, pending: true }), "mermaid");
		assert.equal(escAbortTarget({ ...base, planOpen: true, pending: true }), "plan");
		assert.equal(escAbortTarget({ ...base, setupOpen: true, pending: true }), "setup");
		assert.equal(escAbortTarget({ ...base, pending: true, busy: true }), "question");
		assert.equal(escAbortTarget({ ...base, problem: true, busy: true }), "problem");
		assert.equal(escAbortTarget({ ...base, busy: true }), "turn");
		assert.equal(escAbortTarget({ ...base, abortAsk: true, pending: true }), null);
	});

	it("BYOK refusal envelopes parse from the transport's verbatim text", () => {
		assert.deepEqual(parseModelsRefusal(JSON.stringify({ code: "models_not_configured", missing: ["cheap"] })), ["cheap"]);
		assert.equal(parseModelsRefusal("boom"), null);
		assert.equal(parseProviderKeyRefusal(JSON.stringify({ code: "provider_key_missing", error: "No OpenRouter key is set — add one in Settings → Keys" })), true);
		assert.equal(parseProviderKeyRefusal("{}"), false);
	});
});

describe("demo bridge", () => {
	it("injects before </body> and appends otherwise", () => {
		assert.ok(buildDemoSrcDoc("<html><body>x</body></html>").endsWith(`${DEMO_BRIDGE_SCRIPT}</body></html>`));
		assert.ok(buildDemoSrcDoc("<p>x</p>").endsWith(DEMO_BRIDGE_SCRIPT));
	});

	it("clamps heights and records errors idempotently", () => {
		const state = reduceDemoBridgeState(INITIAL_DEMO_BRIDGE_STATE, { type: "demo-resize", height: 10 });
		assert.equal(state.height, 80);
		assert.equal(reduceDemoBridgeState(state, { type: "demo-resize", height: 10 }), state);
		const failed = reduceDemoBridgeState(state, { type: "demo-error", message: "  " });
		assert.equal(failed.error, "unknown error");
		assert.equal(reduceDemoBridgeState(failed, { type: "demo-error", message: "unknown error" }), failed);
	});
});

describe("presentation helpers", () => {
	it("formats money, tokens and model names exactly", () => {
		assert.equal(formatUsd(0.0122), "$0.0122");
		assert.equal(formatUsd(1.5), "$1.50");
		assert.equal(formatTokens(38000), "38k");
		assert.equal(formatTokens(1234567), "1.2M");
		assert.equal(prettyModel("deepseek/deepseek-v4.1-flash"), "deepseek-v4.1-flash");
		assert.equal(prettyModel("openrouter:z-ai/glm-5.3-0902", true), "glm-5.3 · openrouter");
	});

	it("timeAgo keeps the relative register and ISO fallback", () => {
		const now = new Date("2026-11-01T12:00:00Z");
		assert.equal(timeAgo("2026-11-01T11:59:30Z", now), "just now");
		assert.equal(timeAgo("2026-11-01T11:30:00Z", now), "30m ago");
		assert.equal(timeAgo("2026-10-01T12:00:00Z", now), "2026-10-01");
	});

	it("the confidence rail paints the six-stop ramp", () => {
		assert.equal(CONFIDENCE_COLORS.length, 6);
		assert.match(confidenceRailStyle(0), /#ef4444 0%, #ef4444 0%/);
		assert.match(confidenceRailStyle(50), /#eab308 0%, #eab308 50%/);
	});

	it("hint text appends the live binding", () => {
		assert.match(hintText("Open settings", "open-settings"), /^Open settings \(.*,\)$/);
		assert.equal(hintText("Close", undefined, "escape"), "Close (Esc)");
		assert.equal(hintText("Plain"), "Plain");
	});

	it("code line spans escape HTML and keep one span per line", () => {
		assert.equal(escapeHtml('<a & "b">'), "&lt;a &amp; &quot;b&quot;&gt;");
		assert.equal((lineSpans("a\nb<c").match(/class="line"/g) ?? []).length, 2);
		assert.ok(lineSpans("a\nb<c").includes("&lt;c"));
	});
});
