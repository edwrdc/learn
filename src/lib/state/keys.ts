/** Provider-key presence (pure): tool keys never unlock models. */
import { AUTH_KEYS, type AuthKeyStatus, type AuthProviderInfo, type ModelCatalogResponse } from "@/src/settings/model";

const TOOL_KEY_IDS = new Set<string>(AUTH_KEYS.map((key) => key.id));

export function hasProviderKey(
	statuses: readonly AuthKeyStatus[],
	providers: readonly AuthProviderInfo[] | undefined,
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
