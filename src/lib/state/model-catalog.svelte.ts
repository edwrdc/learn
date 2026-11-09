/** GET /api/models; every menu open refreshes (stale-while-revalidate). */
import { fetchModelCatalog } from "$lib/api/settings";
import { Resource } from "./resource.svelte";
export { catalogLimits } from "./model-catalog";

export const modelCatalog = new Resource("models", fetchModelCatalog, { settings: ["models", "keys"] });
