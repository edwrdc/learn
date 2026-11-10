import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escAbortTarget, initialPromptOwed, parseRefusal } from "../src/lib/chat/chat-logic.ts";
import { codeKeydown, withCode } from "../src/lib/chat/code-input.ts";
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

	it("Esc aborts a question, then a problem, then the turn", () => {
		const base = { abortAsk: false, pending: false, problem: false, busy: false };
		assert.equal(escAbortTarget({ ...base, pending: true, busy: true }), "question");
		assert.equal(escAbortTarget({ ...base, problem: true, busy: true }), "problem");
		assert.equal(escAbortTarget({ ...base, busy: true }), "turn");
		assert.equal(escAbortTarget({ ...base, abortAsk: true, pending: true }), null);
	});

	it("BYOK refusal envelopes parse from the transport's verbatim text", () => {
		assert.equal(parseRefusal(JSON.stringify({ code: "models_not_configured", missing: ["cheap"] })), "models_not_configured");
		assert.equal(parseRefusal("boom"), null);
		assert.equal(parseRefusal(JSON.stringify({ code: "provider_key_missing", error: "No OpenRouter key is set — add one in Settings → Keys" })), "provider_key_missing");
		assert.equal(parseRefusal("{}"), null);
	});
});

describe("learner code input", () => {
	it("withCode joins prose and code and keeps code bytes", () => {
		assert.equal(withCode("", "x"), "```\nx\n```");
		assert.equal(withCode("hi", ""), "hi");
		assert.equal(withCode("  hi  ", "  "), "  hi  ");
		assert.equal(withCode("hi", "x"), "hi\n\n```\nx\n```");
		assert.equal(withCode("hi", "x\n\n"), "hi\n\n```\nx\n\n\n```");
	});

	it("withCode widens the fence past the longest backtick run", () => {
		assert.equal(withCode("hi", "a ``` b"), "hi\n\n````\na ``` b\n````");
	});

	it("withCode never repairs a malformed prose fence", () => {
		const out = withCode("```\nopen", "x");
		assert.ok(out.startsWith("```\nopen\n\n```\nx\n```"));
	});

	it("code keydown: Tab, Enter and Esc ownership", () => {
		const run = (
			key: string,
			opts: Record<string, unknown> = {},
			leave = true,
		) => {
			let value = (opts.value as string) ?? "";
			const calls = { prevented: 0, stopped: 0 };
			const seen = { change: 0, submit: 0, leave: 0 };
			const field = {
				selectionStart: (opts.selectionStart as number) ?? value.length,
				selectionEnd: (opts.selectionEnd as number) ?? value.length,
				get value() {
					return value;
				},
				setRangeText(text: string, from: number, to: number) {
					value = value.slice(0, from) + text + value.slice(to);
				},
			};
			const event = {
				key,
				shiftKey: !!opts.shiftKey,
				ctrlKey: !!opts.ctrlKey,
				metaKey: !!opts.metaKey,
				altKey: !!opts.altKey,
				isComposing: !!opts.isComposing,
				preventDefault: () => calls.prevented++,
				stopPropagation: () => calls.stopped++,
				currentTarget: field,
			} as unknown as KeyboardEvent & { currentTarget: HTMLTextAreaElement };
			codeKeydown(
				event,
				() => seen.change++,
				() => seen.submit++,
				leave ? () => seen.leave++ : undefined,
			);
			return { value, calls, seen };
		};

		const tab = run("Tab", { value: "abcdef", selectionStart: 2, selectionEnd: 4 });
		assert.equal(tab.value, "ab    ef");
		assert.equal(tab.calls.prevented, 1);
		assert.equal(tab.calls.stopped, 1);
		assert.equal(tab.seen.change, 1);
		assert.equal(tab.seen.submit + tab.seen.leave, 0);

		assert.deepEqual(run("Tab", { shiftKey: true }).calls, { prevented: 0, stopped: 0 });
		assert.deepEqual(run("Tab", { ctrlKey: true }).calls, { prevented: 0, stopped: 0 });
		assert.deepEqual(run("Tab", { altKey: true }).calls, { prevented: 0, stopped: 0 });

		const enter = run("Enter");
		assert.deepEqual(enter.calls, { prevented: 0, stopped: 1 });
		assert.equal(enter.seen.submit, 0);
		assert.equal(enter.seen.change, 0);

		const ctrlEnter = run("Enter", { ctrlKey: true });
		assert.deepEqual(ctrlEnter.calls, { prevented: 1, stopped: 1 });
		assert.equal(ctrlEnter.seen.submit, 1);

		const cmdShiftEnter = run("Enter", { metaKey: true, shiftKey: true });
		assert.equal(cmdShiftEnter.seen.submit, 1);

		const composing = run("Enter", { metaKey: true, isComposing: true });
		assert.equal(composing.calls.prevented, 0);
		assert.equal(composing.seen.submit, 0);

		const leave = run("Escape");
		assert.deepEqual(leave.calls, { prevented: 1, stopped: 1 });
		assert.equal(leave.seen.leave, 1);

		const unhandled = run("Escape", {}, false);
		assert.deepEqual(unhandled.calls, { prevented: 0, stopped: 0 });
		assert.equal(unhandled.seen.leave, 0);
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
