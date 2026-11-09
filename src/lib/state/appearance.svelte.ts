/** The resolved appearance as CSS variables on <html>; stale names are
 *  removed so factory values return. */
import { appearanceVars, resolveAppearance, staleVarNames } from "$lib/settings/appearance";
import { settings } from "./settings.svelte";

class AppearanceStore {
	resolved = $derived(resolveAppearance(settings.record?.appearance));
	private applied = new Set<string>();

	/** Call inside an effect: it re-applies whenever the settings change. */
	apply(): void {
		const root = document.documentElement;
		const vars = appearanceVars(this.resolved);
		for (const name of staleVarNames([...this.applied], vars)) {
			root.style.removeProperty(name);
			this.applied.delete(name);
		}
		for (const [name, value] of Object.entries(vars)) {
			root.style.setProperty(name, value);
			this.applied.add(name);
		}
	}
}

export const appearance = new AppearanceStore();
