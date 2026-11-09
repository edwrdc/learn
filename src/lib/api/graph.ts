import type { ExtractionRunView, GraphSnapshot, Position } from "@/src/graph/model";
import type { GraphCostSummary } from "@/src/session/model";
import { deleteJson, getJson, path, postJson, putJson } from "./http";

export const fetchGraph = () => getJson<GraphSnapshot>("/api/graph");

export const fetchGraphCosts = () => getJson<GraphCostSummary>("/api/graph/costs");

export const fetchExtractionRuns = async () => (await getJson<{ runs: ExtractionRunView[] }>("/api/graph/status")).runs;

export const savePositions = async (positions: Record<string, Position>) =>
	(await putJson<{ positions: Record<string, Position> }>("/api/graph/positions", positions)).positions;

export const deleteGraphNode = (id: string) => deleteJson<{ graphRevision: number }>(path`/api/graph/nodes/${id}`);

export const extractChat = (chatId: string) => postJson<{ started: true }>("/api/graph/coverage/extract", { chatId });
