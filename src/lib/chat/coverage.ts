/** Extraction coverage: the settings read that denominates the ring, and
 *  the donut fold. */
import { resolveSettings, type UserSettings } from "@/src/core";

export interface SessionCoverage {
	totalMessages: number;
	coveredCount: number;
	uncoveredCount: number;
	coveredTokens: number;
	uncoveredTokens: number;
	running: boolean;
	lastFoldedAt: string | null;
}

export interface GraphRead {
	enabled: boolean;
	chunkTokens: number;
}

export async function fetchGraphRead(fetchImpl: typeof fetch = fetch): Promise<GraphRead | null> {
	try {
		const res = await fetchImpl("/api/settings");
		if (!res.ok) return null;
		const body = (await res.json()) as { settings?: UserSettings | null };
		const section = resolveSettings(body.settings ?? null).graph;
		return { enabled: section.enabled, chunkTokens: section.extractionChunkTokens };
	} catch {
		return null;
	}
}

export function ringFill(uncoveredTokens: number, chunkTokens: number): number {
	if (!(chunkTokens > 0)) return 0;
	return Math.min(1, Math.max(0, uncoveredTokens / chunkTokens));
}
