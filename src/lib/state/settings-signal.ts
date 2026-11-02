export const SETTINGS_SAVED_EVENT = "lh:settings-saved";

export type SettingsSection = "general" | "keys" | "agent" | "models" | "appearance" | "graph" | "compaction";

export function notifySettingsSaved(section: SettingsSection): void {
	window.dispatchEvent(new CustomEvent(SETTINGS_SAVED_EVENT, { detail: { section } }));
}

export function onSettingsSaved(handler: (section: SettingsSection) => void): () => void {
	const listener = (event: Event) => {
		const section = (event as CustomEvent<{ section?: SettingsSection }>).detail?.section;
		if (section !== undefined) handler(section);
	};
	window.addEventListener(SETTINGS_SAVED_EVENT, listener);
	return () => window.removeEventListener(SETTINGS_SAVED_EVENT, listener);
}

export function watchSettings(handler: (section: SettingsSection) => void): () => void {
	if (typeof window === "undefined") return () => {};
	return onSettingsSaved(handler);
}
