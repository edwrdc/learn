/** One server-backed value: loaded on first read in the browser, reloaded on
 *  the server events and settings saves that can change it (trailing 250ms,
 *  so a burst costs one fetch), on SSE reconnect, and optionally when the
 *  tab becomes visible. A failed load keeps the last value and logs. */
import type { ServerEventType } from "@/src/platform/model";
import { serverEvents } from "./server-events";
import { onAppEvent, type SavedSection } from "$lib/events";

export interface ResourceOptions {
	events?: ServerEventType[];
	settings?: SavedSection[];
	visibility?: boolean;
}

export class Resource<T> {
	#value = $state.raw<T | undefined>(undefined);
	/** The last load failed (the value, if any, is from an earlier load). */
	failed = $state(false);
	#started = false;
	#debounce: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly name: string,
		private readonly load: () => Promise<T>,
		private readonly options: ResourceOptions = {},
	) {}

	get value(): T | undefined {
		this.#start();
		return this.#value;
	}

	/** Adopt a value a write already returned (no refetch). */
	set(value: T): void {
		this.#value = value;
	}

	refresh = async (): Promise<void> => {
		try {
			this.#value = await this.load();
			this.failed = false;
		} catch (error) {
			this.failed = true;
			console.error(`[${this.name}] load failed:`, error);
		}
	};

	#start(): void {
		if (this.#started || typeof window === "undefined") return;
		this.#started = true;
		void this.refresh();
		const schedule = () => {
			clearTimeout(this.#debounce);
			this.#debounce = setTimeout(() => void this.refresh(), 250);
		};
		for (const type of this.options.events ?? []) serverEvents.subscribe(type, schedule);
		if (this.options.events?.length) serverEvents.onResync(() => void this.refresh());
		const sections = this.options.settings;
		if (sections) onAppEvent("settings-saved", ({ section }) => sections.includes(section) && schedule());
		if (this.options.visibility) {
			document.addEventListener("visibilitychange", () => {
				if (document.visibilityState === "visible") void this.refresh();
			});
		}
	}
}
