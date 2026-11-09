/**
 * Native per-provider key resolution (owner, 2026-09-26).
 *
 * The old Agent constructions passed `getApiKey: () => openRouterApiKey()`,
 * which overrode pi-ai's native per-provider env resolution and sent the
 * OpenRouter key to every provider. The fix was deletion. The durable
 * Harness now owns provider calls: the app binds an engine per conversation
 * and supplies no key hook, so pi-ai resolves each provider's key natively.
 * This file pins that no hook or key rides the request options.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { handleChatRequest } from "../src/session/turn.ts";
import "./support-durable.ts";
import { isTurnRunning } from "../src/session/turn-liveness.ts";
import { chatStore } from "../src/session/store.ts";
import { closeChatRuntime } from "../src/session/durable.ts";
import type { PiEngine } from "../src/platform/engines.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const createdChats: string[] = [];
after(async () => {
	for (const id of createdChats) {
		await closeChatRuntime(id).catch(() => undefined);
		await chatStore.deleteChat(id).catch(() => undefined);
	}
});

function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000, what = "condition"): Promise<void> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const tick = async () => {
			if (await cond()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(() => void tick(), 25);
		};
		void tick();
	});
}

describe("the getApiKey-hook fix (native per-provider key resolution)", () => {
	it("the durable turn sends no getApiKey hook and no apiKey", async () => {
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage("ok")]);
		const seen: Array<{ getApiKey?: unknown; apiKey?: unknown }> = [];
		const engine: PiEngine = {
			model: faux.getModel(),
			streamFn: (model, context, options) => {
				seen.push({
					getApiKey: (options as Record<string, unknown> | undefined)?.getApiKey,
					apiKey: options?.apiKey,
				});
				return faux.streamSimple(model, context, options);
			},
		};
		const chat = await chatStore.createChat("getApiKey pin");
		createdChats.push(chat.id);
		await chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		const res = await handleChatRequest(
			new Request("http://test/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: "hello" } }),
			}),
			{ engine },
		);
		assert.equal(res.status, 200, await res.text());
		await waitFor(async () => !(await isTurnRunning(chat.id)), 8000, "the turn settles");
		assert.equal(seen.length, 1, "one provider request");
		assert.equal(
			seen[0]!.getApiKey,
			undefined,
			"a set hook would override pi-ai's native per-provider env resolution for EVERY provider",
		);
		assert.equal(seen[0]!.apiKey, undefined, "no key is pinned on the request");
	});
});
