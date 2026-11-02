import type { AuthKeyStatus } from "@/src/core";
import { watchSettings } from "./settings-signal";
import { hasProviderKey, type ProviderKeyInfo } from "./keys";
export { hasProviderKey, strongKeyless, type ProviderKeyInfo } from "./keys";


class KeysStore {
	zero = $state(false);
	initialized = false;
	private off: (() => void) | null = null;

	init(): void {
		if (this.initialized || typeof window === "undefined") return;
		this.initialized = true;
		this.read();
		this.off = watchSettings((section) => {
			if (section === "keys") this.read();
		});
	}

	read = (): void => {
		Promise.all([
			fetch("/api/keys").then((r) => {
				if (!r.ok) throw new Error(`keys request failed: ${r.status}`);
				return r.json() as Promise<{ keys?: AuthKeyStatus[]; providers?: ProviderKeyInfo[] } | null>;
			}),
			fetch("/api/custom-endpoint").then((r) => {
				if (!r.ok) throw new Error(`custom endpoint request failed: ${r.status}`);
				return r.json() as Promise<{ keyPresent?: boolean } | null>;
			}),
		])
			.then(([body, custom]) => {
				if (!Array.isArray(body?.keys) || typeof custom?.keyPresent !== "boolean") return;
				this.zero = !hasProviderKey(body.keys, body.providers, custom.keyPresent);
			})
			.catch(() => {});
	};
}

export const keys = new KeysStore();
