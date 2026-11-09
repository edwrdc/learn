/**
 * The notification channel's client half, framework-free: ONE EventSource
 * per window, a window-local fan-out, and resync callbacks fired on every
 * (re)open. Consumers react by refetching truth; payloads stay fact-only.
 */
import { SERVER_EVENT_TYPES, type ServerEventType, type ServerEvents } from "@/src/platform/model";

type Listener = (payload: unknown) => void;

export class ServerEventHub {
	private source: EventSource | null = null;
	private byType = new Map<string, Set<Listener>>();
	private resyncs = new Set<() => void>();

	start(): void {
		if (this.source !== null || typeof window === "undefined") return;
		const source = new EventSource("/api/events");
		this.source = source;
		for (const name of SERVER_EVENT_TYPES) {
			source.addEventListener(name, (event) => {
				this.dispatch(name, (event as MessageEvent).data);
			});
		}
		source.onopen = () => this.fireOpen();
	}

	stop(): void {
		this.source?.close();
		this.source = null;
	}

	subscribe<K extends ServerEventType>(type: K, cb: (payload: ServerEvents[K]) => void): () => void {
		const set = this.byType.get(type) ?? new Set<Listener>();
		this.byType.set(type, set);
		const slot = cb as unknown as Listener;
		set.add(slot);
		return () => set.delete(slot);
	}

	onResync(cb: () => void): () => void {
		this.resyncs.add(cb);
		return () => this.resyncs.delete(cb);
	}

	private dispatch(name: string, raw: string): void {
		const set = this.byType.get(name);
		if (!set) return;
		let payload: unknown;
		try {
			payload = JSON.parse(raw);
		} catch (err) {
			console.error(`[events] unparseable frame for ${name}:`, err);
			return;
		}
		for (const cb of [...set]) {
			try {
				cb(payload);
			} catch (err) {
				console.error(`[events] ${name} handler failed:`, err);
			}
		}
	}

	private fireOpen(): void {
		for (const cb of [...this.resyncs]) {
			try {
				cb();
			} catch (err) {
				console.error("[events] resync handler failed:", err);
			}
		}
	}
}

export const serverEvents = new ServerEventHub();
