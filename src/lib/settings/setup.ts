/** Pure setup-dialog seams: stage selection and slot prefill. */
import type { ModelCatalogEntry, ModelSlotName } from "@/src/settings/model";
import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
import { populateLevel } from "./compose";

export const SLOT_ORDER: readonly ModelSlotName[] = ["strong", "cheap", "vision"];

export function setupStage(providers: { id: string; keyPresent: boolean }[] | null): "keys" | "pickers" {
	if (providers === null) return "keys";
	return providers.some((provider) => provider.keyPresent) ? "pickers" : "keys";
}

export function prefillFromSlots(
	models: ModelCatalogEntry[],
	slots: Record<ModelSlotName, { model: { provider: string; id: string } } | null> | undefined,
): Partial<Record<ModelSlotName, ModelCatalogEntry>> {
	const pre: Partial<Record<ModelSlotName, ModelCatalogEntry>> = {};
	for (const slot of SLOT_ORDER) {
		const pin = slots?.[slot];
		const entry = pin?.model ? models.find((model) => model.provider === pin.model!.provider && model.id === pin.model!.id) : undefined;
		if (entry) pre[slot] = entry;
	}
	return pre;
}

export function prefillLevelFromPin(
	entry: ModelCatalogEntry,
	pin: { thinkingLevel?: ThinkingLevel } | null | undefined,
): ThinkingLevel {
	return populateLevel(pin?.thinkingLevel, entry.supportedLevels);
}
