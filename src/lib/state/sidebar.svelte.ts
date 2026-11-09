import { onKeyAction } from "$lib/events";
import { IS_ELECTRON } from "./desktop";
import { sidebarAutocloseWidth } from "../../../electron/shared.json";

const STORAGE_KEY = "lh:sidebar-open";

class SidebarStore {
	pref = $state(false);
	narrow = $state(false);
	mounted = $state(false);
	open = $derived(this.pref && !this.narrow);
	private initialized = false;

	init(): void {
		if (this.initialized || typeof window === "undefined") return;
		this.initialized = true;
		if (IS_ELECTRON) {
			const onResize = () => (this.narrow = window.innerWidth < sidebarAutocloseWidth);
			onResize();
			window.addEventListener("resize", onResize);
		}
		const stored = localStorage.getItem(STORAGE_KEY);
		this.pref = stored === null ? true : stored === "1";
		this.mounted = true;
		onKeyAction("toggle-sidebar", () => this.toggle());
		// Synchronize across tabs (the preference is per device, shared).
		window.addEventListener("storage", (event) => {
			if (event.key !== STORAGE_KEY) return;
			this.pref = event.newValue === "1";
		});
	}

	toggle = (): void => {
		if (this.narrow && !this.open) {
			localStorage.setItem(STORAGE_KEY, "0");
			this.pref = true;
			window.lh?.expandWindow();
			return;
		}
		this.pref = !this.pref;
		localStorage.setItem(STORAGE_KEY, this.pref ? "1" : "0");
	};
}

export const sidebar = new SidebarStore();
