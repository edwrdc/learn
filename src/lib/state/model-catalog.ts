/** Catalog index helpers (pure; the rune store owns fetching). */
import { modelKey, type ModelCatalogResponse } from "@/src/settings/model";

export function catalogLimits(catalog: Pick<ModelCatalogResponse, "models">): Map<string, number> {
	return new Map(catalog.models.map((m) => [modelKey(m.provider, m.id), m.contextWindow]));
}
