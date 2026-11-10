/** The stored keys and provider list (GET /api/keys) plus the custom
 *  endpoint's key presence, reloaded after a keys save. */
import type { CustomEndpointState } from "@/src/settings/model";
import { deleteKey, fetchCustomEndpoint, fetchKeys, removeCustomEndpoint as deleteCustomEndpoint, saveCustomEndpoint as putCustomEndpoint, saveKey as putKey } from "$lib/api/settings";
import { emitAppEvent } from "$lib/events";
import { Resource } from "./resource.svelte";
import { hasProviderKey, strongKeyless } from "./keys";
import { modelCatalog } from "./model-catalog.svelte";
export { hasProviderKey, strongKeyless } from "./keys";

export const keys = new Resource(
	"keys",
	async () => {
		const [body, custom] = await Promise.all([fetchKeys(), fetchCustomEndpoint()]);
		return { ...body, customKeyPresent: custom.keyPresent };
	},
	{ settings: ["keys"] },
);

/** Is no model-provider key present at all (the setup nudge)? Undefined
 *  until the keys load. */
export const noProviderKey = {
	get value(): boolean | undefined {
		const value = keys.value;
		return value && !hasProviderKey(value.keys, value.providers, value.customKeyPresent);
	},
};

/** A send opens setup first: a slot is unpicked, no provider key is
 *  stored, or the strong slot's provider has no key. */
export function needsSetup(configured: boolean): boolean {
	return !configured || !!noProviderKey.value || strongKeyless(modelCatalog.value);
}

/** Store one provider key and announce the save (the keys reload on it).
 *  Throws what the write throws. */
export async function saveKey(id: string, value: string): Promise<void> {
	await putKey(id, value);
	emitAppEvent("settings-saved", { section: "keys" });
}

/** Remove one stored provider key and announce the save. Throws what the write throws. */
export async function removeKey(id: string): Promise<void> {
	await deleteKey(id);
	emitAppEvent("settings-saved", { section: "keys" });
}

/** Announce a custom-endpoint write: the endpoint carries models and a key. */
function announceEndpoint(state: CustomEndpointState): CustomEndpointState {
	emitAppEvent("settings-saved", { section: "models" });
	emitAppEvent("settings-saved", { section: "keys" });
	return state;
}

/** Save the custom endpoint; returns its new state. Throws what the write throws. */
export async function saveCustomEndpoint(body: unknown): Promise<CustomEndpointState> {
	return announceEndpoint(await putCustomEndpoint(body));
}

/** Remove the custom endpoint; returns its new state. Throws what the write throws. */
export async function removeCustomEndpoint(): Promise<CustomEndpointState> {
	return announceEndpoint(await deleteCustomEndpoint());
}
