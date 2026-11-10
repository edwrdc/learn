/** The Keys section's pure projection: grouping and status lines. */
import { AUTH_KEYS, type AuthKeyStatus, type AuthProviderInfo } from "@/src/settings/model";

const TOOL_IDS = AUTH_KEYS.map((key) => key.id) as readonly string[];

export function classifyKeys(statuses: readonly AuthKeyStatus[], providers: readonly AuthProviderInfo[] | undefined) {
	const byId = new Map(statuses.map((status) => [status.id, status]));
	const isTool = (id: string) => TOOL_IDS.includes(id);
	const providerEnv = new Set((providers ?? []).map((provider) => provider.envVar));
	const synth = (id: string): AuthKeyStatus => ({ id, info: null, present: false, masked: null, source: "none", shadowedByEnv: false });
	const providerRows: AuthKeyStatus[] = [];
	const unknownRows: AuthKeyStatus[] = [];
	for (const status of statuses) {
		if (isTool(status.id)) continue;
		if (providerEnv.has(status.id) || (!status.info && providers === undefined)) providerRows.push(status);
		else if (!status.info) unknownRows.push(status);
		else providerRows.push(status);
	}
	return {
		providerRows,
		toolRows: TOOL_IDS.map((id) => byId.get(id) ?? synth(id)),
		unknownRows,
		addable: (providers ?? []).filter((provider) => !byId.has(provider.envVar)),
	};
}

export function keyStatusLine(status: AuthKeyStatus): string {
	if (!status.present || !status.masked) return "not set";
	const tail = status.masked.replace(/ \((\d+) chars\)$/, "");
	const chars = status.masked.match(/\((\d+) chars\)$/)?.[1] ?? "?";
	return `${tail} · ${chars}${status.source === "env" ? " · env" : ""}`;
}
