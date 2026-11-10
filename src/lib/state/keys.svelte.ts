/** The stored keys and provider list (GET /api/keys) plus the custom
 *  endpoint's key presence, reloaded after a keys save. */
import { fetchCustomEndpoint, fetchKeys } from "$lib/api/settings";
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
