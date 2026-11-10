/**
 * The single place concrete store adapters are wired. Everything else codes
 * against the port types and receives instances through this module.
 */

import { chatStore } from "./session/store.ts";
import { graphStore } from "./graph/store.ts";
import { jobStore } from "./jobs/store.ts";
import { readSettings } from "./settings/store.ts";
import { resolveSettings, type EffectiveSettings } from "./settings/model/resolution.ts";
export const stores = {
	chatStore,
	graphStore,
	jobStore,
};

/**
 * The resolved view of the settings record: every knob concrete over its
 * factory default — EXCEPT MODELS (BYOK all the way down, owner decision):
 * no factory pins exist, so unset model slots resolve to null and per-need
 * refusal gates fire downstream. Read fresh on every call — the record is a
 * small file and turns are rare, so no caching layer (stale toggles after a
 * settings PUT would be worse).
 */
export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(readSettings());
}
