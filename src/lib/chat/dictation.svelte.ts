export const DG_URL =
	"wss://api.deepgram.com/v1/listen" +
	"?model=nova-3" +
	"&encoding=linear16" +
	"&sample_rate=16000" +
	"&channels=1" +
	"&smart_format=true" +
	"&punctuate=true" +
	"&endpointing=300";

export const METER_TICK_MS = 60;
export const METER_CELLS = 48;
export const DEEPGRAM_KEY_ID = "DEEPGRAM_API_KEY";
export const DICTATION_KEYLESS = "Dictation needs a Deepgram key";
export const WARM_TOKEN_TTL_MS = 3 * 60_000;

export type DictationPhase = "idle" | "connecting" | "recording" | "stopping";

export function joinDictation(current: string, final: string): string {
	return current ? current.replace(/\s+$/, "") + " " + final : final;
}

export function rmsToMeter(rms: number): number {
	if (rms <= 0) return 0;
	const db = 20 * Math.log10(rms);
	const t = (db - -50) / (-10 - -50);
	return Math.max(0, Math.min(1, t));
}

async function mintFreshToken(): Promise<string> {
	const res = await fetch("/api/stt/token");
	const data = (await res.json()) as { token?: string; message?: string };
	if (!res.ok || !data.token) {
		if (res.status === 503) throw new Error(DICTATION_KEYLESS);
		throw new Error(data.message ?? `token route ${res.status}`);
	}
	return data.token;
}

export function createWarmMinter(mint: () => Promise<string>, now: () => number = Date.now, ttlMs = WARM_TOKEN_TTL_MS) {
	let warm: { p: Promise<string>; at: number } | null = null;
	const minter = {
		mint: () => {
			if (!warm || now() - warm.at > ttlMs) {
				const p = mint().catch((error) => {
					warm = null;
					throw error;
				});
				warm = { p, at: now() };
			}
			return warm.p;
		},
		refresh: () => {
			warm = null;
			void minter.mint().catch(() => {});
		},
	};
	return minter;
}

const warmTokens = createWarmMinter(mintFreshToken);

let sharedCtx: AudioContext | null = null;
let workletModule: Promise<void> | null = null;

function ensureAudioGraph(): { ctx: AudioContext; module: Promise<void> } {
	if (!sharedCtx) sharedCtx = new AudioContext({ sampleRate: 16000 });
	if (!workletModule) {
		workletModule = sharedCtx.audioWorklet.addModule("/worklets/pcm-capture.js").catch((error) => {
			workletModule = null;
			throw error;
		});
	}
	return { ctx: sharedCtx, module: workletModule };
}

let claimedTarget: ((text: string) => void) | null = null;
let live: DictationController | null = null;

export function setDictationTarget(append: ((text: string) => void) | null): void {
	claimedTarget = append;
}

export function dictationActive(): boolean {
	return live?.active === true;
}

export function cancelDictation(): void {
	live?.cancel();
}

export function finishDictation(): Promise<void> {
	return live?.finish() ?? Promise.resolve();
}

export class DictationController {
	phase = $state<DictationPhase>("idle");
	error = $state<string | null>(null);
	level = 0;
	active = $derived(this.phase !== "idle");

	private append: (text: string) => void;
	private ws: WebSocket | null = null;
	private stream: MediaStream | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private worklet: AudioWorkletNode | null = null;
	private pending: ArrayBuffer[] = [];
	private gen = 0;
	private safety: ReturnType<typeof setTimeout> | null = null;
	private reconnects = 0;
	private buffer: string[] = [];
	private waiters: Array<() => void> = [];
	private initialized = false;

	constructor(append: (text: string) => void) {
		this.append = append;
	}

	mount(): () => void {
		if (typeof window === "undefined") return () => {};
		live = this;
		const toggle = () => this.toggle();
		const cancel = () => this.cancel();
		window.addEventListener("lh:kbd-toggle-dictation", toggle);
		window.addEventListener("lh:kbd-cancel-dictation", cancel);
		if (!this.initialized) {
			this.initialized = true;
			warmTokens.refresh();
		}
		return () => {
			window.removeEventListener("lh:kbd-toggle-dictation", toggle);
			window.removeEventListener("lh:kbd-cancel-dictation", cancel);
			if (live === this) live = null;
		};
	}

	setAppend(append: (text: string) => void): void {
		this.append = append;
	}

	private flush(): void {
		if (this.buffer.length === 0) return;
		const text = this.buffer.join(" ");
		this.buffer = [];
		(claimedTarget ?? this.append)(text);
	}

	private cleanup(): void {
		this.gen++;
		this.flush();
		if (this.safety) {
			clearTimeout(this.safety);
			this.safety = null;
		}
		this.pending = [];
		for (const track of this.stream?.getTracks() ?? []) track.stop();
		this.stream = null;
		this.source?.disconnect();
		this.source = null;
		this.worklet?.disconnect();
		this.worklet = null;
		const ws = this.ws;
		this.ws = null;
		if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
			try {
				ws.close();
			} catch {
				/* already gone */
			}
		}
		this.phase = "idle";
		for (const waiter of this.waiters.splice(0)) waiter();
		warmTokens.refresh();
	}

	private openSocket(gen: number, token: string): void {
		const ws = new WebSocket(DG_URL, ["bearer", token]);
		this.ws = ws;
		ws.addEventListener("open", () => {
			if (gen !== this.gen) return;
			for (const frame of this.pending) ws.send(frame);
			this.pending = [];
			this.phase = "recording";
		});
		ws.addEventListener("message", (event) => {
			if (gen !== this.gen) return;
			let msg: { type?: string; is_final?: boolean; channel?: { alternatives?: Array<{ transcript?: string }> } };
			try {
				msg = JSON.parse(event.data as string);
			} catch {
				return;
			}
			if (msg.type === "Results" && msg.is_final) {
				const text = msg.channel?.alternatives?.[0]?.transcript;
				if (text) this.buffer.push(text);
			}
		});
		ws.addEventListener("close", (event) => {
			if (gen !== this.gen) return;
			if (event.code === 1000) {
				this.cleanup();
				return;
			}
			if (this.reconnects < 1) {
				this.reconnects++;
				void mintFreshToken()
					.then((fresh) => {
						if (gen === this.gen) this.openSocket(gen, fresh);
					})
					.catch(() => {
						if (gen === this.gen) {
							this.error = "Deepgram reconnect failed";
							this.cleanup();
						}
					});
			} else {
				this.error = `Deepgram connection lost (${event.code})`;
				this.cleanup();
			}
		});
	}

	private async start(): Promise<void> {
		this.error = null;
		this.phase = "connecting";
		this.reconnects = 0;
		this.buffer = [];
		this.pending = [];
		const gen = ++this.gen;
		const tokenPromise = warmTokens.mint();
		tokenPromise.catch(() => {});
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
			if (gen !== this.gen) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			this.stream = stream;
			const { ctx, module } = ensureAudioGraph();
			await module;
			if (ctx.state === "suspended") await ctx.resume();
			if (gen !== this.gen) return;
			const worklet = new AudioWorkletNode(ctx, "pcm-capture");
			this.worklet = worklet;
			worklet.port.onmessage = (event: MessageEvent) => {
				const msg = event.data as { type: string; rms?: number; buffer?: ArrayBuffer };
				if (msg.type === "level") {
					this.level = msg.rms ?? 0;
				} else if (msg.type === "audio" && msg.buffer) {
					const ws = this.ws;
					if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg.buffer);
					else {
						this.pending.push(msg.buffer);
						if (this.pending.length > 256) this.pending.shift();
					}
				}
			};
			const source = ctx.createMediaStreamSource(stream);
			this.source = source;
			source.connect(worklet);
			worklet.connect(ctx.destination);
		} catch (error) {
			if (gen !== this.gen) return;
			this.error =
				error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")
					? "Microphone permission denied"
					: error instanceof Error
						? error.message
						: "mic unavailable";
			this.cleanup();
			return;
		}
		if (gen !== this.gen) return;
		let token: string;
		try {
			token = await tokenPromise;
		} catch (error) {
			if (gen !== this.gen) return;
			this.error = error instanceof Error ? error.message : "token unavailable";
			this.cleanup();
			return;
		}
		if (gen !== this.gen) return;
		this.openSocket(gen, token);
	}

	stop = (): void => {
		const gen = this.gen;
		if (this.phase !== "recording" && this.phase !== "connecting") return;
		this.phase = "stopping";
		for (const track of this.stream?.getTracks() ?? []) track.stop();
		this.stream = null;
		this.source?.disconnect();
		this.source = null;
		this.worklet?.disconnect();
		this.worklet = null;
		const ws = this.ws;
		if (ws && ws.readyState === WebSocket.OPEN) {
			try {
				ws.send(JSON.stringify({ type: "CloseStream" }));
			} catch {
				this.cleanup();
				return;
			}
			this.safety = setTimeout(() => {
				if (gen === this.gen) this.cleanup();
			}, 3000);
		} else {
			this.cleanup();
		}
	};

	cancel = (): void => {
		if (this.phase === "idle") return;
		this.buffer = [];
		this.cleanup();
	};

	finish = (): Promise<void> => {
		return new Promise((resolve) => {
			if (this.phase === "idle") {
				resolve();
				return;
			}
			this.waiters.push(resolve);
			if (this.phase === "recording" || this.phase === "connecting") this.stop();
		});
	};

	toggle = (): void => {
		if (this.phase === "idle") void this.start();
		else if (this.phase === "recording" || this.phase === "connecting") this.stop();
	};

	clearError = (): void => {
		this.error = null;
	};
}

export function isDictationActive(): boolean {
	return live?.active === true;
}
