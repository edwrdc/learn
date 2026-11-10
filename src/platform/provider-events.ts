/**
 * The raw-wire recorder. pi-ai's onProviderStreamEvent observer fires for
 * each parsed provider stream event before pi normalizes it — the layer
 * where provider quirks live (e.g. GLM-flash truncating tool-call arguments
 * mid-JSON, DeepSeek resetting tool-call ids every response) and nothing
 * else in the app can see.
 *
 * Gating (owner decision): env var only — `LH_PROVIDER_EVENTS=1 npm run dev`.
 * Default off: raw events carry full prompts (privacy) and unbounded volume.
 *
 * Artifact: one JSONL file per chat at data/debug/provider-events/<chatId>.jsonl,
 * no retention. Each line:
 *   {"t":<epoch ms>,"ctx":"teacher|prober|job:<role>","provider":…,"model":…,"event":<raw>}
 * plus {"note":…} run markers. Past the byte cap it writes one truncation
 * marker and stops. An observer exception must not kill a stream, so a
 * non-serializable event degrades to a type note.
 */

import { processState } from "./model/index.ts";
import * as fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.ts";

/** Max bytes per chat's JSONL before recording stops (with a marker). */
export const PROVIDER_EVENTS_CAP_BYTES = 20 * 1024 * 1024;

const EVENTS_DIR = path.join(PATHS.debug, "provider-events");

/** The model shape the observer receives (structural — pi passes Model). */
interface ProviderEventModel {
	provider?: string;
	id?: string;
}

export type ProviderEventObserver = (data: unknown, model: ProviderEventModel) => void;

/** Per-file accounting so the cap marker writes exactly once. */
function files(): Map<string, { bytes: number; capped: boolean }> {
	return processState("providerEventFiles", () => new Map());
}

function fileFor(chatId: string): string {
	const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
	return path.join(EVENTS_DIR, `${safe}.jsonl`);
}

function writeLine(file: string, line: Record<string, unknown>): void {
	const state = files().get(file);
	if (state?.capped) return;
	const text = `${JSON.stringify({ t: Date.now(), ...line })}\n`;
	try {
		const before = state?.bytes ?? (fs.existsSync(file) ? fs.statSync(file).size : 0);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, text, "utf-8");
		const bytes = before + Buffer.byteLength(text);
		if (bytes > PROVIDER_EVENTS_CAP_BYTES) {
			files().set(file, { bytes, capped: true });
			fs.appendFileSync(file, `${JSON.stringify({ t: Date.now(), note: `cap ${PROVIDER_EVENTS_CAP_BYTES} bytes reached — recording stopped` })}\n`, "utf-8");
		} else {
			files().set(file, { bytes, capped: false });
		}
	} catch {
		// The debug recorder must never take a run down with it.
	}
}

/** Encode an adapter-owned event safely: JSON when it cooperates, a type
 *  note when it does not (cyclic/BigInt payloads). */
function encodeEvent(data: unknown): unknown {
	try {
		JSON.stringify(data);
		return data;
	} catch {
		return { __nonSerializable: typeof data };
	}
}

/** Read per call: toggling the env var needs no restart. */
export function providerEventsEnabled(): boolean {
	return !!process.env.LH_PROVIDER_EVENTS;
}

/** The observer for one run, or undefined when disabled. */
export function providerEventObserver(chatId: string, context: string): ProviderEventObserver | undefined {
	if (!providerEventsEnabled()) return undefined;
	return (data, model) => {
		writeLine(fileFor(chatId), {
			ctx: context,
			provider: model?.provider,
			model: model?.id,
			event: encodeEvent(data),
		});
	};
}

/** A run marker (start/end/abort notes) so events correlate with the
 *  persisted record; no-op when disabled. */
export function providerEventNote(chatId: string, context: string, text: string): void {
	if (!providerEventsEnabled()) return;
	writeLine(fileFor(chatId), { ctx: context, note: text });
}
