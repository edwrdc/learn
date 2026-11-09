/** Catalog index helpers (pure; the rune store owns fetching). */
import type { ModelCatalogResponse } from "@/src/settings/model";

export function catalogLimits(catalog: Pick<ModelCatalogResponse, "models">): Map<string, number> {
	return new Map(catalog.models.map((m) => [`${m.provider}:${m.id}`, m.contextWindow]));
}
