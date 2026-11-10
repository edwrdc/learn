/**
 * Graph render settings (the settings.json `graphRender` section): the
 * shape, the defaults, the sanitizer, and the slider mapping the graph
 * view's controls use.
 *
 * Sizes (nodeSize, labelSize, arrowLength, regions.dilation, regions.blur)
 * are world units, so identical settings render identically at any graph
 * size and zoom.
 *
 * labelZoom is a camera-ratio threshold (1 = fit zoom, smaller = zoomed
 * in): node labels show at ratio <= labelZoom and cross-fade with the
 * cluster labels (see LABELS_FADE_RATIO in src/lib/home).
 *
 * Slider ladders (owner decision): every non-physics knob moves on a
 * hand-authored 11-stop ladder with the default dead-center, so a knob's
 * possible values are the ladder — the sanitizer snaps any incoming value
 * to the nearest entry. Physics keeps fine-grained log sliders.
 */

/** How the inference rank is expressed spatially: `follows`/`supports`
 *  edges encode derivation, so depth-0 nodes (the fundamentals) anchor a
 *  shared baseline and every derivation level rises from it.
 *  `vertical`: levels are horizontal rows, arrows point up.
 *  `radial`: levels are concentric rings, foundations at the center.
 *  `off`: free layout. */
export type DepthAnchorMode = "off" | "vertical" | "radial";

export const LINK_DISTANCE = 40;
export const CHARGE_STRENGTH = -240;
/** The live sim reuses this so its rest state matches the server settle's
 *  equilibrium. */
export const INCREMENTAL_GRAVITY = 0.12;
/** Default cluster-centroid pull: compact enough to read as blobs, weak
 *  enough that cluster shape is still the edge network's. */
export const CLUSTER_PULL_STRENGTH = 0.15;

export interface GraphRenderSettings {
	/** World units, like every size here. */
	nodeSize: number;
	edgeWidth: number;
	arrowLength: number;
	/** Camera-ratio threshold for node labels (see module doc). */
	labelZoom: number;
	/** Node + hover label font size, world units (scales with camera). */
	labelSize: number;
	/** Toggle for the cluster region labels (hulls always draw). */
	clusterLabels: boolean;
	/** Cluster label font size, screen px (constant at any zoom, unlike
	 *  labelSize). */
	clusterLabelSize: number;
	/** Region rendering (the blurred cluster tints). */
	regions: RegionTuning;
	/** Live-sim physics + inference-depth anchoring. */
	physics: PhysicsTuning;
}


const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** Coerce arbitrary JSON into valid settings: missing keys fall back to
 *  defaults, values snap/clamp, wrong types reset. Never throws. */
export function sanitizeRenderSettings(raw: unknown): GraphRenderSettings {
	const r = (raw ?? {}) as Partial<GraphRenderSettings>;
	const ladd = (v: unknown, ladder: readonly number[], dflt: number) =>
		typeof v === "number" && Number.isFinite(v) ? snapToLadder(v, ladder) : dflt;
	return {
		nodeSize: ladd(r.nodeSize, NODE_SIZE_LADDER, DEFAULT_RENDER_SETTINGS.nodeSize),
		edgeWidth: ladd(r.edgeWidth, EDGE_WIDTH_LADDER, DEFAULT_RENDER_SETTINGS.edgeWidth),
		arrowLength: ladd(r.arrowLength, ARROW_LENGTH_LADDER, DEFAULT_RENDER_SETTINGS.arrowLength),
		labelZoom: ladd(r.labelZoom, LABEL_ZOOM_LADDER, DEFAULT_RENDER_SETTINGS.labelZoom),
		labelSize: ladd(r.labelSize, LABEL_SIZE_LADDER, DEFAULT_RENDER_SETTINGS.labelSize),
		clusterLabels:
			typeof r.clusterLabels === "boolean" ? r.clusterLabels : DEFAULT_RENDER_SETTINGS.clusterLabels,
		clusterLabelSize: ladd(
			r.clusterLabelSize,
			CLUSTER_LABEL_SIZE_LADDER,
			DEFAULT_RENDER_SETTINGS.clusterLabelSize,
		),
		regions: sanitizeRegionTuning(r.regions),
		physics: sanitizePhysicsTuning(r.physics),
	};
}

// ─── Region + physics tuning ──────────────────────────────────────────────────
//
// Every physics clamp below is a sweep-validated safe range (real graph,
// the renderer's exact sim): each field at both range ends and all range
// corners settles cleanly — no NaN, no explosion (linkStrength ≥ 8 explodes
// the layout, 5 wobbles; cap 4), no non-settle (velocityDecay 0 never
// damps), no sprawl (gravity 0 / charge -1000 excluded). CHARGE_RANGE sits
// inside the validated |charge| range [30, 480].

/** Region rendering knobs (the blurred cluster tints). */
export interface RegionTuning {
	/** Dilation half-width of the round-cap edge strokes, world units. */
	dilation: number;
	/** Region softness: the blur's reach, world units (3 box-blur passes ≈
	 *  Gaussian). The renderer rasterizes it to bitmap px, floor 1px. */
	blur: number;
	/** Max bitmap dimension (cell = worldSpan / this), one of
	 *  REGION_BITMAP_OPTIONS. */
	bitmap: number;
	/** Region alpha, applied once after the blur, so overlaps never stack
	 *  (per-stroke alpha accumulated through source-over). */
	edgeAlpha: number;
	/** false = the renderer skips the region build entirely (compute, not
	 *  just paint). Cluster labels follow `clusterLabels` instead. */
	enabled: boolean;
}

export const REGION_BITMAP_OPTIONS = [128, 192, 256, 384, 512] as const;
export const DEFAULT_REGION_TUNING: RegionTuning = {
	dilation: 20,
	blur: 40,
	bitmap: 256,
	edgeAlpha: 0.2,
	enabled: true,
};

/** Snap a region tuning onto its ladders and allowed bitmap sizes. */
export function sanitizeRegionTuning(input: Partial<RegionTuning> | null | undefined): RegionTuning {
	const d = DEFAULT_REGION_TUNING;
	const num = (v: unknown, fallback: number): number =>
		typeof v === "number" && Number.isFinite(v) ? v : fallback;
	const bitmap = num(input?.bitmap, d.bitmap);
	const ladd = (v: unknown, ladder: readonly number[], dflt: number) =>
		typeof v === "number" && Number.isFinite(v) ? snapToLadder(v, ladder) : dflt;
	return {
		dilation: ladd(input?.dilation, REGION_DILATION_LADDER, d.dilation),
		blur: ladd(input?.blur, REGION_BLUR_LADDER, d.blur),
		bitmap: snapToLadder(bitmap, REGION_BITMAP_OPTIONS),
		edgeAlpha: ladd(input?.edgeAlpha, REGION_EDGE_ALPHA_LADDER, d.edgeAlpha),
		enabled: typeof input?.enabled === "boolean" ? input.enabled : true,
	};
}

/** Live-sim physics controls: every value feeds createGraphSimulation — the
 *  same engine the server settle runs. */
export interface PhysicsTuning {
	/** Node repulsion (d3 charge, negative = push apart). */
	chargeStrength: number;
	/** Edge attraction: link-spring stiffness multiplier (1 = d3 default). */
	linkStrength: number;
	/** Link spring rest length (world units). */
	linkDistance: number;
	/** Central pull toward the graph centroid. */
	gravity: number;
	/** Per-cluster pull toward the cluster centroid. 0 = off. */
	clusterPull: number;
	/** Per-tick velocity damping (d3 default 0.4). */
	velocityDecay: number;
	/** Inference-depth anchoring mode (see DepthAnchor in src/graph/model). */
	depthMode: DepthAnchorMode;
	/** Depth-anchor pull strength. */
	depthStrength: number;
	/** Spacing between inference levels (world units). */
	depthSpacing: number;
	/** Inner ring radius, radial mode (world units). */
	depthBaseRadius: number;
}

export const DEFAULT_PHYSICS_TUNING: PhysicsTuning = {
	chargeStrength: CHARGE_STRENGTH,
	linkStrength: 1,
	linkDistance: LINK_DISTANCE,
	gravity: INCREMENTAL_GRAVITY,
	clusterPull: CLUSTER_PULL_STRENGTH,
	velocityDecay: 0.4,
	depthMode: "off",
	// By sweep on a real graph: 0.8 reads upward with organic sag; 1.5 gives
	// crisp rows.
	depthStrength: 0.8,
	depthSpacing: 60,
	depthBaseRadius: 220,
};

/** Clamp anything into a usable tuning (sliders/JSON can be empty/NaN). */
export function sanitizePhysicsTuning(input: Partial<PhysicsTuning> | null | undefined): PhysicsTuning {
	const d = DEFAULT_PHYSICS_TUNING;
	const num = (v: unknown, fallback: number): number =>
		typeof v === "number" && Number.isFinite(v) ? v : fallback;
	return {
		chargeStrength: Math.min(Math.max(num(input?.chargeStrength, d.chargeStrength), CHARGE_RANGE.min), CHARGE_RANGE.max),
		linkStrength: Math.min(Math.max(num(input?.linkStrength, d.linkStrength), LINK_STRENGTH_RANGE.min), LINK_STRENGTH_RANGE.max),
		linkDistance: Math.min(Math.max(num(input?.linkDistance, d.linkDistance), LINK_DISTANCE_RANGE.min), LINK_DISTANCE_RANGE.max),
		gravity: Math.min(Math.max(num(input?.gravity, d.gravity), GRAVITY_RANGE.min), GRAVITY_RANGE.max),
		clusterPull: Math.min(Math.max(num(input?.clusterPull, d.clusterPull), 0), CLUSTER_PULL_RANGE.max),
		velocityDecay: Math.min(Math.max(num(input?.velocityDecay, d.velocityDecay), VELOCITY_DECAY_RANGE.min), VELOCITY_DECAY_RANGE.max),
		depthMode: input?.depthMode === "vertical" || input?.depthMode === "radial" ? input.depthMode : "off",
		depthStrength: Math.min(Math.max(num(input?.depthStrength, d.depthStrength), DEPTH_STRENGTH_RANGE.min), DEPTH_STRENGTH_RANGE.max),
		depthSpacing: Math.min(Math.max(num(input?.depthSpacing, d.depthSpacing), DEPTH_SPACING_RANGE.min), DEPTH_SPACING_RANGE.max),
		depthBaseRadius: Math.min(Math.max(num(input?.depthBaseRadius, d.depthBaseRadius), DEPTH_BASE_RADIUS_RANGE.min), DEPTH_BASE_RADIUS_RANGE.max),
	};
}

// The owner's live-tuned values, each dead-center on its ladder.
export const DEFAULT_RENDER_SETTINGS: GraphRenderSettings = {
	nodeSize: 2,
	edgeWidth: 1,
	arrowLength: 2,
	// Displays as 1× (see labelZoomDisplay).
	labelZoom: 0.5,
	labelSize: 3,
	clusterLabels: true,
	clusterLabelSize: 14,
	regions: DEFAULT_REGION_TUNING,
	physics: DEFAULT_PHYSICS_TUNING,
};

// ─── The slider ladders ──────────────────────────────────────────────────────
//
// 11 stops, the default at index 5 (slider position 50; the slider steps by
// 10, one stop per detent). Mostly the two-per-octave nice-number series
// (x1.5 / x1.33 alternation).
export const NODE_SIZE_LADDER = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12] as const;
export const EDGE_WIDTH_LADDER = [0.1, 0.2, 0.4, 0.6, 0.8, 1, 1.5, 2, 3, 4, 6] as const;
export const ARROW_LENGTH_LADDER = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12] as const;
export const LABEL_SIZE_LADDER = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16] as const;
// Screen px at any zoom (drawn at size / k).
export const CLUSTER_LABEL_SIZE_LADDER = [7, 8, 9, 10, 12, 14, 16, 18, 20, 24, 28] as const;
// Camera-ratio gates; displayed via labelZoomDisplay (ratio 0.5 = 1×).
export const LABEL_ZOOM_LADDER = [0.125, 0.175, 0.25, 0.35, 0.45, 0.5, 0.75, 1, 1.5, 2, 3] as const;

// ─── Region ladders + physics slider ranges ───────────────────────────────────
//
// Physics sliders are log-scaled with the default at 50 (each default is the
// geometric mean, gm, of its range ends). chargeStrength is negative — the
// slider maps |charge| and displays "-x"; clusterPull has an off zone —
// position 0 is exactly 0 (see toOffSliderPosition).

export const REGION_DILATION_LADDER = [4, 5, 7.5, 10, 15, 20, 30, 40, 60, 80, 120] as const; // world units
export const REGION_BLUR_LADDER = [10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120] as const; // world units
export const REGION_EDGE_ALPHA_LADDER = [0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6, 0.8, 1] as const;

export const CHARGE_RANGE = { min: -480, max: -120 } as const; // |gm| = 240
export const LINK_STRENGTH_RANGE = { min: 0.25, max: 4 } as const; // gm = 1
export const LINK_DISTANCE_RANGE = { min: 10, max: 160 } as const; // gm = 40
export const GRAVITY_RANGE = { min: 0.03, max: 0.48 } as const; // gm = 0.12
export const CLUSTER_PULL_RANGE = { min: 0.0225, max: 1 } as const; // gm = 0.15; 0 = off
export const VELOCITY_DECAY_RANGE = { min: 0.18, max: 0.9 } as const; // gm ≈ 0.40
export const DEPTH_STRENGTH_RANGE = { min: 0.2, max: 3.2 } as const; // gm = 0.8
export const DEPTH_SPACING_RANGE = { min: 15, max: 240 } as const; // gm = 60
export const DEPTH_BASE_RADIUS_RANGE = { min: 55, max: 880 } as const; // gm = 220

/** Nearest ladder entry (ties break low). */
export function snapToLadder(value: number, ladder: readonly number[]): number {
	return ladder.reduce((best, v) => (Math.abs(v - value) < Math.abs(best - value) ? v : best), ladder[0] as number);
}

/** Ladder index of a value (nearest; ties break low). */
function ladderIndex(value: number, ladder: readonly number[]): number {
	let best = 0;
	for (let i = 1; i < ladder.length; i++)
		if (Math.abs(ladder[i] as number - value) < Math.abs(ladder[best] as number - value)) best = i;
	return best;
}

/** Setting value → ladder slider position [0, 100]. */
export function toLadderPosition(value: number, ladder: readonly number[]): number {
	return ladderIndex(clampToLadder(value, ladder), ladder) * 10;
}

/** Ladder slider position [0, 100] → setting value (the ladder entry). */
export function fromLadderPosition(position: number, ladder: readonly number[]): number {
	const i = Math.min(Math.max(Math.round(position / 10), 0), ladder.length - 1);
	return ladder[i] as number;
}

function clampToLadder(value: number, ladder: readonly number[]): number {
	return clamp(value, ladder[0] as number, ladder[ladder.length - 1] as number);
}

/** Off-aware slider mapping (position 0 → value 0 = OFF; the log range
 *  starts one step in). Inverse of fromOffSliderPosition. */
export function toOffSliderPosition(value: number, min: number, max: number): number {
	if (value <= 0) return 0;
	return toSliderPosition(value, min, max);
}

/** Off-aware slider mapping: position 0 → 0 (off), else log-scaled. */
export function fromOffSliderPosition(position: number, min: number, max: number): number {
	if (position <= 0) return 0;
	return fromSliderPosition(position, min, max);
}

/** Setting value → slider position [0, 100] (log scale, default at 50). */
export function toSliderPosition(value: number, min: number, max: number): number {
	const v = clamp(value, min, max);
	const logSpan = Math.log(max / min);
	return (100 * Math.log(v / min)) / logSpan;
}

/** Slider position [0, 100] → setting value (inverse of toSliderPosition). */
export function fromSliderPosition(position: number, min: number, max: number): number {
	const p = clamp(position, 0, 100) / 100;
	const logSpan = Math.log(max / min);
	return min * Math.exp(p * logSpan);
}

/** Display units for labelZoom: ratio / 0.5, so the default reads 1×. */
export function labelZoomDisplay(labelZoom: number): string {
	const v = Math.round((labelZoom / 0.5) * 100) / 100;
	return `${v}×`;
}
