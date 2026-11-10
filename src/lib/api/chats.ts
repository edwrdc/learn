import type { JobRecord } from "@/src/jobs/model";
import type { ChatSettings, ChatListItem, ChatView } from "@/src/session/model";
import type { ChatDeleteMode } from "@/src/graph/model";
import { deleteJson, getJson, path, postJson, putJson } from "./http";

export const fetchChat = (id: string, init?: RequestInit) => getJson<ChatView>(path`/api/chats/${id}`, init);

export const listChats = async () => (await getJson<{ chats: ChatListItem[] }>("/api/chats", { cache: "no-store" })).chats;

export const createChat = (body: { title: string; kind?: "practice"; graphContext?: { propositions: unknown[] } }) =>
	postJson<{ id: string; title: string }>("/api/chats", body);

export const renameChat = (id: string, title: string) => putJson<{ title: string }>(path`/api/chats/${id}`, { title });

export const deleteChat = (id: string, mode: ChatDeleteMode) =>
	deleteJson<{ ok: true; graphRevision: number }>(`${path`/api/chats/${id}`}?mode=${mode}`);

export const saveChatSettings = (id: string, settings: ChatSettings) =>
	putJson<{ settings: ChatSettings }>(path`/api/chats/${id}/settings`, settings);

export const setArtifactInverted = (id: string, messageId: string, inverted: boolean) =>
	postJson<{ ok: true }>(path`/api/chats/${id}/artifact-ui`, { input: { messageId, inverted } });

export const fetchJobs = (chatId: string) =>
	getJson<{ jobs: JobRecord[]; turnInFlight: boolean }>(`/api/jobs?chatId=${encodeURIComponent(chatId)}`);

export const abortProcess = (kind: "job" | "extraction" | "turn", id: string) => postJson<{ ok: true }>("/api/activity/abort", { kind, id });
