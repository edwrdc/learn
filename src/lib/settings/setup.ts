/** Pure setup-dialog seams: stage selection and slot prefill. */
import { MODEL_SLOTS, ROLE_SLOT, type ModelCatalogEntry, type ModelRole, type ModelSlotName } from "@/src/settings/model";
import { jobAgentLabel } from "@/src/tools/model";
import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
import { populateLevel } from "./compose";

export const SLOT_ORDER: readonly ModelSlotName[] = ["strong", "cheap", "vision"];

const ROLE_LABEL: Record<ModelRole, string> = {
	prober: "Prober",
	teacher: "Teacher",
	researcher: jobAgentLabel("research"),
	demoBuilder: jobAgentLabel("demo"),
	visualMaker: jobAgentLabel("visual"),
	pdfReader: jobAgentLabel("pdf"),
	extractor: "Extractor",
	auditor: "Auditor",
};
const SLOT_LABEL: Record<ModelSlotName, string> = { strong: "Strong", cheap: "Cheap", vision: "Vision" };

/** Each slot's name and the agents it runs (ROLE_SLOT order). */
export const SLOT_META = Object.fromEntries(
	MODEL_SLOTS.map((slot) => [
		slot,
		{
			label: SLOT_LABEL[slot],
			roster: (Object.keys(ROLE_SLOT) as ModelRole[])
				.filter((role) => ROLE_SLOT[role] === slot)
				.map((role) => ROLE_LABEL[role])
				.join(", "),
		},
	]),
) as Record<ModelSlotName, { label: string; roster: string }>;

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
