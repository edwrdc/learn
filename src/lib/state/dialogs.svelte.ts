export type SettingsSectionId = "keys" | "agent" | "appearance" | "graph" | "keyboard";

class SettingsDialogStore {
	show = $state(false);
	section = $state<SettingsSectionId>("keys");
	row = $state<string | null>(null);

	open(section?: string, row?: string): void {
		if (section) this.section = section as SettingsSectionId;
		this.row = row ?? null;
		this.show = true;
	}

	close(): void {
		this.show = false;
	}
}

export const settingsDialog = new SettingsDialogStore();

class CheatSheetStore {
	open = $state(false);
}

export const cheatSheet = new CheatSheetStore();
