/** The graph view's camera, remembered per browser (a convenience: storage
 *  may be unavailable, and then the view simply fits). */
export type Camera = { k: number; x: number; y: number };

const CAMERA_KEY = "lh.graph.camera.v1";

export function readCamera(): Camera | null {
	try {
		const parsed = JSON.parse(localStorage.getItem(CAMERA_KEY) ?? "null") as Partial<Camera> | null;
		return parsed && typeof parsed.k === "number" && parsed.k > 0 && typeof parsed.x === "number" && typeof parsed.y === "number"
			? (parsed as Camera)
			: null;
	} catch {
		return null;
	}
}

/** Camera moves saved 250ms after the last one; `flush` saves a pending
 *  move now (the view is closing). */
export function cameraSaver(): { save: (camera: Camera) => void; flush: () => void } {
	let pending: Camera | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const write = () => {
		clearTimeout(timer);
		if (!pending) return;
		try {
			localStorage.setItem(CAMERA_KEY, JSON.stringify(pending));
		} catch {
			// storage unavailable: the camera is not remembered
		}
		pending = null;
	};
	return {
		save: (camera) => {
			pending = camera;
			clearTimeout(timer);
			timer = setTimeout(write, 250);
		},
		flush: write,
	};
}
