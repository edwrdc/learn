declare global {
	interface Window {
		/** The Electron preload bridge (electron/preload.cjs) — absent in a
		 *  plain browser. */
		lh?: {
			platform?: string;
			expandWindow: () => void;
			onZoom?: (cb: (factor: number) => void) => () => void;
			getZoom?: () => Promise<number>;
			onUpdateStatus?: (cb: (status: { status: string; version: string | null }) => void) => () => void;
			installUpdate?: () => void;
		};
	}

	namespace App {
	}
}

export {};
