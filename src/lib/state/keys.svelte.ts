/** Is no model-provider key present at all (the setup nudge)? */
import { fetchCustomEndpoint, fetchKeys } from "$lib/api/settings";
import { Resource } from "./resource.svelte";
import { hasProviderKey } from "./keys";
export { hasProviderKey, strongKeyless } from "./keys";

export const noProviderKey = new Resource(
	"keys",
	async () => {
		const [body, custom] = await Promise.all([fetchKeys(), fetchCustomEndpoint()]);
		return !hasProviderKey(body.keys, body.providers, custom.keyPresent);
	},
	{ settings: ["keys"] },
);
