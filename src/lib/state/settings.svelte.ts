/** The user settings record (GET /api/settings), reloaded after any save. */
import { resolveSettings, slotsConfigured, type EffectiveSettings, type UserSettings } from "@/src/settings/model";
import { fetchSettings, saveSettingsSection } from "$lib/api/settings";
import { emitAppEvent, type SavedSection } from "$lib/events";
import { Resource } from "./resource.svelte";

class SettingsStore {
	#record = new Resource<UserSettings | null>("settings", fetchSettings, {
		settings: ["agent", "models", "appearance", "graph", "compaction", "keys"],
	});

	/** Undefined until the first load lands; null on a first boot. */
	get record(): UserSettings | null | undefined {
		return this.#record.value;
	}

	get resolved(): EffectiveSettings | undefined {
		const record = this.record;
		return record === undefined ? undefined : resolveSettings(record);
	}

	/** Every model slot is picked (the first-run gate); undefined until the
	 *  first load lands. */
	get configured(): boolean | undefined {
		const record = this.record;
		return record === undefined ? undefined : slotsConfigured(record?.models);
	}

	get failed(): boolean {
		return this.#record.failed;
	}

	refresh(): Promise<void> {
		return this.#record.refresh();
	}

	set(record: UserSettings): void {
		this.#record.set(record);
	}

	/** Write one section, adopt the record the write returns, and announce
	 *  the save. Throws what the write throws. */
	async save(section: Exclude<SavedSection, "keys">, body: unknown): Promise<void> {
		this.set(await saveSettingsSection(section, body));
		emitAppEvent("settings-saved", { section });
	}
}

export const settings = new SettingsStore();
