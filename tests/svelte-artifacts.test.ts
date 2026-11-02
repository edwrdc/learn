/** Svelte ports of the SVG image boundary, zero-keys truth, setup stage 1,
 *  and tooltip composition. */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { AuthKeyStatus, ModelCatalogResponse } from "../src/core/index.ts";
import { svgImageSource } from "../src/lib/artifacts/svg.ts";
import { hasProviderKey, strongKeyless } from "../src/lib/state/keys.ts";
import { hintText, TOOLTIP_DELAY_MS } from "../src/lib/hint.ts";
import { closeSvelteSsr, renderSvelte } from "./support-svelte-ssr.ts";

after(closeSvelteSsr);
const html = async (path: string, props: Record<string, unknown> = {}) =>
	(await renderSvelte(path, props)).body.replace(/<!--[^>]*-->/g, "");

const FIGURE = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><style>text{font-family:Arial}</style><defs><marker id="arrow"><path d="M0 0L5 5"/></marker></defs><path marker-end="url(#arrow)" d="M0 0L20 20"/><text>θ &amp; φ: 50% #1</text></svg>`;
const ACTIVE = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="example()"><script>example()</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml" onclick="example()">Example</div></foreignObject><a href="javascript:example()"><text>Link</text></a><image href="https://example.invalid/image.png"/></svg>`;
const PREFIX = "data:image/svg+xml;charset=utf-8,";

function assertImageBoundary(holder: Element, source: string) {
	const image = holder.querySelector("img");
	assert.ok(image, "figure is an image");
	assert.equal(holder.children.length, 1);
	assert.equal(holder.querySelector("svg, style, script, foreignObject, a, [onload], [onclick]"), null);
	assert.equal(image.getAttribute("alt"), "Figure");
	assert.equal(image.getAttribute("draggable"), "false");
	const src = image.getAttribute("src")!;
	assert.ok(src.startsWith(PREFIX));
	assert.equal(decodeURIComponent(src.slice(PREFIX.length)), source);
	return image;
}

describe("SVG display compatibility", () => {
	it("leaves standalone SVG unchanged, including comments and CDATA", () => {
		const source = FIGURE.replace("</svg>", '<!-- &nbsp; <svg> --><![CDATA[&nbsp; <svg>]]></svg>');
		assert.equal(svgImageSource(source), source);
	});

	it("adds only a missing root namespace, idempotently", () => {
		const source = '<?xml version="1.0"?><!-- <svg xmlns="wrong"> --><svg data-note=\' xmlns="not-a-declaration" >\' xmlns:xlink="http://www.w3.org/1999/xlink"><svg/></svg>';
		const expected = source.replace("<svg data-note=", '<svg xmlns="http://www.w3.org/2000/svg" data-note=');
		assert.equal(svgImageSource(source), expected);
		assert.equal(svgImageSource(expected), expected);
	});

	it("keeps explicit namespace declarations untouched", () => {
		for (const declaration of ['xmlns="http://www.w3.org/2000/svg"', "xmlns = 'other'", 'xmlns=""']) {
			const source = `<svg ${declaration}><text>Example</text></svg>`;
			assert.equal(svgImageSource(source), source);
		}
	});

	it("converts nbsp in text and attributes, never comments/CDATA/PIs", () => {
		const source = '<?example &nbsp;?><svg xmlns="http://www.w3.org/2000/svg" aria-label="A&nbsp;B"><text>A&nbsp;B &amp;nbsp; &#160;</text><!-- &nbsp; --><![CDATA[&nbsp;]]></svg>';
		const expected = source.replace('aria-label="A&nbsp;B"', 'aria-label="A&#160;B"').replace("<text>A&nbsp;B", "<text>A&#160;B");
		assert.equal(svgImageSource(source), expected);
		assert.equal(svgImageSource(expected), expected);
	});
});

describe("generated SVG image boundary", () => {
	for (const [name, source] of [["style/fragment IDs", FIGURE], ["active markup", ACTIVE]] as const) {
		it(`inline isolates ${name} inside the image URL, on white backing`, async () => {
			const body = await html("/src/lib/artifacts/VisualOutputCard.svelte", { output: { svg: source } });
			const holder = parseHTML(body).document.querySelector('[data-testid="visual-svg"]')!;
			assertImageBoundary(holder, source);
			assert.ok(holder.classList.contains("bg-white"));
		});

		it(`fullscreen isolates ${name} inside the image URL`, async () => {
			const body = await html("/src/lib/chat/SessionOverlay.svelte", { svg: source, onClose: () => {} });
			const holder = parseHTML(body).document.querySelector("[data-lh-overlay-chart]")!;
			assertImageBoundary(holder, source);
			assert.ok(holder.classList.contains("bg-white"));
		});
	}

	for (const [name, original, display] of [
		["missing namespace", '<svg width="320" height="160"><text>Example</text></svg>', '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><text>Example</text></svg>'],
		["HTML entity", '<svg xmlns="http://www.w3.org/2000/svg"><text>A&nbsp;B</text></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><text>A&#160;B</text></svg>'],
	] as const) {
		it(`repairs ${name} only in the image source`, async () => {
			const output = { svg: original };
			const body = await html("/src/lib/artifacts/VisualOutputCard.svelte", { output });
			assertImageBoundary(parseHTML(body).document.querySelector('[data-testid="visual-svg"]')!, display);
			assert.equal(output.svg, original);
		});
	}

	it("retains inversion on the white backing", async () => {
		const body = await html("/src/lib/artifacts/VisualOutputCard.svelte", { output: { svg: FIGURE }, initialInverted: true });
		const holder = parseHTML(body).document.querySelector('[data-testid="visual-svg"]')!;
		assert.match(holder.getAttribute("style")!, /invert\(1\) hue-rotate\(180deg\)/);
		assert.ok(holder.classList.contains("bg-white"));
		assertImageBoundary(holder, FIGURE);
	});

	it("inline retains natural width and only shrinks oversized figures", async () => {
		const body = await html("/src/lib/artifacts/VisualOutputCard.svelte", { output: { svg: FIGURE } });
		const document = parseHTML(body).document;
		const image = assertImageBoundary(document.querySelector('[data-testid="visual-svg"]')!, FIGURE);
		assert.equal(image.getAttribute("width"), "320");
		assert.equal(image.className, "block h-auto max-w-full");
		assert.ok(document.querySelector('[data-testid="visual-card"]')!.classList.contains("w-fit"));
	});

	for (const width of ["", ' width="100%"']) {
		it(`keeps the full-width fallback for ${width || "viewBox-only"} SVG`, async () => {
			const source = `<svg xmlns="http://www.w3.org/2000/svg"${width} viewBox="0 0 320 160"><text>Example</text></svg>`;
			const body = await html("/src/lib/artifacts/VisualOutputCard.svelte", { output: { svg: source } });
			const document = parseHTML(body).document;
			const image = assertImageBoundary(document.querySelector('[data-testid="visual-svg"]')!, source);
			assert.equal(image.getAttribute("width"), null);
			assert.equal(image.className, "block h-auto w-full");
			assert.ok(document.querySelector('[data-testid="visual-card"]')!.classList.contains("w-full"));
		});
	}

	it("fullscreen keeps the natural-size box and zoom controls", async () => {
		const body = await html("/src/lib/chat/SessionOverlay.svelte", { svg: FIGURE, onClose: () => {} });
		const document = parseHTML(body).document;
		const holder = document.querySelector("[data-lh-overlay-chart]")!;
		assert.equal(assertImageBoundary(holder, FIGURE).className, "block h-auto w-full");
		assert.match(holder.parentElement!.getAttribute("style")!, /width:\s*320px/);
		for (const label of ["Zoom in", "Zoom out", "Fit diagram to view", "Close"]) assert.ok(document.querySelector(`button[aria-label="${label}"]`), label);
	});
});

describe("zero-keys truth", () => {
	const status = (id: string, present: boolean, source: AuthKeyStatus["source"] = present ? "file" : "none"): AuthKeyStatus => ({ id, info: null, present, masked: present ? "…ab12 (64 chars)" : null, source, shadowedByEnv: false });
	const PROVIDERS = [{ id: "openrouter", envVar: "OPENROUTER_API_KEY", label: "OpenRouter" }, { id: "anthropic", envVar: "ANTHROPIC_API_KEY", label: "Anthropic" }];

	it("present provider keys count; tool keys alone do not", () => {
		assert.equal(hasProviderKey([status("OPENROUTER_API_KEY", true, "env")], PROVIDERS), true);
		assert.equal(hasProviderKey([status("ANTHROPIC_API_KEY", true, "file")], PROVIDERS), true);
		assert.equal(hasProviderKey([status("DEEPGRAM_API_KEY", true)], PROVIDERS), false);
	});

	it("a configured custom endpoint key counts", () => {
		assert.equal(hasProviderKey([], PROVIDERS, true), true);
		assert.equal(hasProviderKey([], PROVIDERS, false), false);
	});

	it("strongKeyless fires only when the strong pin's provider key is gone", () => {
		const catalog = (strongProvider: string | null, ...keyed: string[]): ModelCatalogResponse => ({
			models: [],
			defaults: null,
			rolePins: { researcher: null, demoBuilder: null, visualMaker: null, extractor: null, auditor: null },
			slots: { strong: strongProvider ? { model: { provider: strongProvider, id: `${strongProvider}/model` }, thinkingLevel: "low" } : null, cheap: null, vision: null },
			providers: keyed.map((id) => ({ id, envVar: `${id.toUpperCase()}_API_KEY`, keyPresent: true })),
		});
		assert.equal(strongKeyless(catalog("openrouter", "anthropic")), true);
		assert.equal(strongKeyless(catalog("openrouter")), true);
		assert.equal(strongKeyless(catalog("openrouter", "openrouter", "anthropic")), false);
		const lying = catalog("openrouter", "openrouter");
		lying.providers[0]!.keyPresent = false;
		assert.equal(strongKeyless(lying), true);
		assert.equal(strongKeyless(catalog(null, "openrouter")), false);
		assert.equal(strongKeyless(undefined), false);
	});
});

describe("setup stage 1 (static)", () => {
	it("before a fetch: Add a provider key, trigger, no key input", async () => {
		const body = await html("/src/lib/settings/SetupDialog.svelte", { open: true, onClose: () => {}, onDone: () => {} });
		assert.match(body, /Add a provider key\./);
		assert.ok(body.includes("Pick a provider…"));
		assert.ok(body.includes('data-testid="setup-key-provider"'));
		assert.ok(!body.includes('data-testid="setup-key-input"'));
		assert.ok(body.includes('data-testid="setup-backdrop"'));
		assert.ok(body.includes('data-testid="setup-dialog"'));
	});
});

describe("tooltip composition", () => {
	it("hintText appends the live binding and uses 500ms", async () => {
		assert.equal(TOOLTIP_DELAY_MS, 500);
		const { IS_MAC } = await import("../src/core/keyboard.ts");
		assert.equal(hintText("Dictate", "toggle-dictation"), IS_MAC ? "Dictate (⌘D)" : "Dictate (Ctrl+D)");
		assert.equal(hintText("Close", undefined, "escape"), "Close (Esc)");
		assert.equal(hintText("Send", undefined, "enter"), "Send (↵)");
		assert.equal(hintText("Home"), "Home");
	});
});
