/** Provider-key presence (pure): tool keys never unlock models. */
import type { AuthKeyStatus, ModelCatalogResponse } from "@/src/settings/model";

export interface ProviderKeyInfo { id: string; envVar: string; label: string }

const TOOL_KEY_IDS = new Set(["DEEPGRAM_API_KEY", "TAVILY_API_KEY", "BRAVE_API_KEY"]);

export function hasProviderKey(
	statuses: readonly AuthKeyStatus[],
	providers: readonly ProviderKeyInfo[] | undefined,
	customEndpointKey = false,
): boolean {
	if (customEndpointKey) return true;
	const providerEnv = new Set((providers ?? []).map((provider) => provider.envVar));
	return statuses.some(
		(status) =>
			status.present === true &&
			(providerEnv.has(status.id) || (!status.info && providers === undefined) || (!!status.info && !TOOL_KEY_IDS.has(status.id))),
	);
}

export function strongKeyless(catalog: ModelCatalogResponse | undefined): boolean {
	const strong = catalog?.slots.strong;
	if (!strong) return false;
	return !catalog.providers.some((provider) => provider.id === strong.model.provider && provider.keyPresent);
}
