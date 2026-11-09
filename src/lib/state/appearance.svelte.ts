/**
 * Appearance application: resolved CSS variables on <html>, with
 * removal of stale names so factory values return. One fetch per load;
 * settings writes call `onAppearanceChange`.
 */
import { browser } from "$app/environment";
import type { AppearanceSettings, UserSettings } from "@/src/settings/model";
import { appearanceVars, resolveAppearance, staleVarNames } from "$lib/settings/appearance";



class AppearanceStore {
	delta = $state<AppearanceSettings | undefined>(undefined);
	resolved = $derived(resolveAppearance(this.delta));
	private applied = new Set<string>();
	private initialized = false;

	init(): void {
		if (!browser || this.initialized) return;
		this.initialized = true;
		this.apply();
		fetch("/api/settings")
			.then((r) => r.json() as Promise<{ settings?: UserSettings | null }>)
			.then((body) => {
				const appearance = body.settings?.appearance;
				this.set(appearance && typeof appearance === "object" ? appearance : undefined);
			})
			.catch(() => {});
	}

	set(next: AppearanceSettings | undefined): void {
		this.delta = next;
		if (browser) this.apply();
	}

	private apply(): void {
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
