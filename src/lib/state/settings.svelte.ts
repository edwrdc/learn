/** The user settings record (GET /api/settings), reloaded after any save. */
import { resolveSettings, type EffectiveSettings, type UserSettings } from "@/src/settings/model";
import { fetchSettings } from "$lib/api/settings";
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

	get failed(): boolean {
		return this.#record.failed;
	}

	refresh(): Promise<void> {
		return this.#record.refresh();
	}

	set(record: UserSettings): void {
		this.#record.set(record);
	}
}

export const settings = new SettingsStore();
