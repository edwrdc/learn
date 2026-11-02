import { kbdEventForAction } from "@/src/core";

const STORAGE_KEY = "lh:sidebar-open";
const SIDEBAR_AUTOCLOSE = 928;
export const IS_ELECTRON = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

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
			document.documentElement.classList.add("lh-electron");
			document.documentElement.dataset.lhPlatform = window.lh?.platform ?? "";
			const setZoom = (factor: number) => document.documentElement.style.setProperty("--lh-zoom", String(factor));
			window.lh?.onZoom?.(setZoom);
			void window.lh?.getZoom?.().then(setZoom);
			const onResize = () => (this.narrow = window.innerWidth < SIDEBAR_AUTOCLOSE);
			onResize();
			window.addEventListener("resize", onResize);
		}
		const stored = localStorage.getItem(STORAGE_KEY);
		this.pref = stored === null ? true : stored === "1";
		this.mounted = true;
		window.addEventListener(kbdEventForAction("toggle-sidebar"), () => this.toggle());
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
