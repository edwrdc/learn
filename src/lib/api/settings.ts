import type {
	AuthKeyStatus,
	AuthProviderInfo,
	CustomEndpointState,
	ModelCatalogResponse,
	PromptSegmentInfo,
	SettingsSection,
	UserSettings,
} from "@/src/settings/model";
import type { SearchStatus } from "@/src/tools/model";
import { deleteJson, getJson, path, postJson, putJson } from "./http";

export const fetchSettings = async () => (await getJson<{ settings: UserSettings | null }>("/api/settings")).settings;

export const saveSettingsSection = async (section: SettingsSection, value: unknown) =>
	(await putJson<{ settings: UserSettings }>(path`/api/settings/${section}`, value)).settings;

export const fetchPromptSegments = () => getJson<{ prober: PromptSegmentInfo[]; teacher: PromptSegmentInfo[] }>("/api/settings/prompts");

/** The segment path is a mirror-layout path ("teacher/20-teaching.md"); the
 *  route takes it encoded as one catch-all segment. */
export const savePromptOverride = (segment: string, text: string) =>
	putJson<{ path: string; text: string }>(path`/api/settings/prompts/${segment}`, { text });

export const deletePromptOverride = (segment: string) =>
	deleteJson<{ path: string; deleted: true; switchCleared: boolean }>(path`/api/settings/prompts/${segment}`);

export const fetchModelCatalog = () => getJson<ModelCatalogResponse>("/api/models");

export const fetchKeys = () => getJson<{ keys: AuthKeyStatus[]; providers: AuthProviderInfo[] }>("/api/keys");

export const saveKey = async (id: string, value: string) => (await putJson<{ status: AuthKeyStatus }>(path`/api/keys/${id}`, { value })).status;

export const deleteKey = async (id: string) => (await deleteJson<{ status: AuthKeyStatus }>(path`/api/keys/${id}`)).status;

export const fetchCustomEndpoint = () => getJson<CustomEndpointState>("/api/custom-endpoint");

export const saveCustomEndpoint = (body: unknown) => putJson<CustomEndpointState>("/api/custom-endpoint", body);

export const removeCustomEndpoint = () => deleteJson<CustomEndpointState>("/api/custom-endpoint");

export const discoverCustomModels = async (body: { baseUrl: string; apiKey?: string }) =>
	(await postJson<{ models: Array<{ id: string; name: string }> }>("/api/custom-endpoint/models", body)).models;

export const fetchSearchStatus = () => getJson<SearchStatus>("/api/search");

export const mintDictationToken = async () => (await getJson<{ token: string }>("/api/stt/token")).token;
