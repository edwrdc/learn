import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { RUNTIME_EXTERNALS as BUNDLE_EXTERNALS } from "../scripts/build-server.mjs";
import config from "../svelte.config.js";

const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("packaged server externals", () => {
	it("keeps every runtime-loaded engine/native package out of the bundle", () => {
		for (const name of [
			"@earendil-works/pi-ai",
			"@earendil-works/pi-durable",
			"@earendil-works/chord",
			"pdfjs-dist",
			"@napi-rs/canvas",
			"@resvg/resvg-js",
			"puppeteer-core",
		]) {
			assert.ok(BUNDLE_EXTERNALS.includes(name), name);
		}
	});

	it("never bumps the pinned engine/runtime versions", () => {
		assert.equal(manifest.dependencies["@earendil-works/pi-ai"], "1.4.0");
		assert.equal(manifest.dependencies["@earendil-works/pi-durable"], "1.4.0");
		assert.equal(manifest.dependencies["@earendil-works/chord"], "1.4.0");
		assert.equal(manifest.dependencies.katex, "0.18.2");
	});

	it("keeps public/ as the static-asset root (every existing URL stays valid)", () => {
		assert.equal(config.kit!.files!.assets, "public");
	});
});
