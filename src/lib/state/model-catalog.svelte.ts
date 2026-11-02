/** GET /api/models, cached per page load; every menu open refreshes
 *  (stale-while-revalidate). */
import type { ModelCatalogResponse } from "@/src/core";

let cache: ModelCatalogResponse | undefined;
let inflight: Promise<ModelCatalogResponse> | undefined;

function fetchCatalog(force = false): Promise<ModelCatalogResponse> {
	if (force) {
		cache = undefined;
		inflight = undefined;
	}
	inflight ??= fetch("/api/models")
		.then((r) => {
			if (!r.ok) throw new Error(`catalog request failed: ${r.status}`);
			return r.json() as Promise<ModelCatalogResponse>;
		})
		.then((catalog) => {
			cache = catalog;
			return catalog;
		})
		.catch((err) => {
			inflight = undefined;
			throw err;
		});
	return inflight;
}

class ModelCatalogStore {
	catalog = $state<ModelCatalogResponse | undefined>(cache);

	ensure(): void {
		if (this.catalog || typeof window === "undefined") return;
		fetchCatalog()
			.then((catalog) => (this.catalog = catalog))
			.catch(() => {});
	}

	refresh(): void {
		fetchCatalog(true)
			.then((catalog) => (this.catalog = catalog))
			.catch(() => {});
	}
}

export const modelCatalog = new ModelCatalogStore();


export { catalogLimits } from "./model-catalog";
