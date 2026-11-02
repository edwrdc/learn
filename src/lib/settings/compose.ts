import { DEFAULT_THINKING_ORDER, type AgentSettings, type ModelSlotName, type ModelsSettings } from "@/src/core";
import type { KeyAction } from "@/src/core";
import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";

export const THINKING_LABEL: Record<string, string> = {
	off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
};

export function defaultOrderLevel(supported: readonly ThinkingLevel[]): ThinkingLevel {
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

export function populateLevel(explicit: ThinkingLevel | undefined, supported: readonly ThinkingLevel[]): ThinkingLevel {
	return explicit ?? defaultOrderLevel(supported);
}

export function composeSlotModel(
	models: ModelsSettings | undefined,
	slot: ModelSlotName,
	provider: string,
	id: string,
	thinking: string,
): ModelsSettings {
	const previous = models?.[slot];
	const next = { ...models };
	if (!provider && !id && !thinking) {
		delete next[slot];
		return next;
	}
	next[slot] = {
		...(provider && id ? { model: { provider, id } } : previous?.model ? { model: previous.model } : {}),
		...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
	};
	return next;
}


export const PROMPT_IN_USE_HINT = "Your version is in use";

export interface SegmentInfo {
	path: string;
	sourceText: string;
	overrideText: string | null;
	enabled: boolean;
	shared: boolean;
}

export interface PromptSection {
	id: "teacher" | "prober" | "shared";
	label: string;
	hint?: string;
	segments: SegmentInfo[];
}

export function composeTool(agent: AgentSettings | undefined, id: string, on: boolean): AgentSettings {
	return { ...agent, tools: { ...agent?.tools, [id]: on } };
}

export function composeQuizMechanics(agent: AgentSettings | undefined, mechanics: "choice" | "free"): AgentSettings {
	return { ...agent, tools: { ...agent?.tools, explain: mechanics === "free" } };
}

export function composeSearchEngine(
	agent: AgentSettings | undefined,
	engine: "tavily" | "brave" | null,
): AgentSettings {
	if (engine === null) {
		if (!agent?.search) return { ...agent } as AgentSettings;
		const { search: _drop, ...rest } = agent;
		return rest as AgentSettings;
	}
	return { ...agent, search: { engine } };
}

export function composePromptSwitch(agent: AgentSettings | undefined, path: string, on: boolean): AgentSettings {
	const prompts = { ...agent?.prompts };
	if (on) prompts[path] = true;
	else delete prompts[path];
	return { ...agent, prompts };
}

export function sectionedSegments(view: { prober: SegmentInfo[]; teacher: SegmentInfo[] }): PromptSection[] {
	const own = (who: "prober" | "teacher") => view[who].filter((segment) => !segment.shared);
	return [
		{ id: "teacher", label: "Teacher", segments: own("teacher") },
		{ id: "prober", label: "Prober", segments: own("prober") },
		{
			id: "shared",
			label: "Shared",
			hint: "Used by both agents",
			segments: view.teacher.filter((segment) => segment.shared),
		},
	];
}

export function nextOverrides(
	current: Partial<Record<KeyAction, string>>,
	id: KeyAction,
	binding: string | null,
): Partial<Record<KeyAction, string>> {
	const next = { ...current };
	if (binding === null) delete next[id];
	else next[id] = binding;
	return next;
}
