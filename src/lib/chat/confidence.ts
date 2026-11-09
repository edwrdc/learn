import { CONFIDENCE_STOPS } from "@/src/session/model";

export const CONFIDENCE_COLORS: readonly string[] = ["#ef4444", "#f97316", "#eab308", "#84cc16", "#22c55e", "#10b981"];

export function confidenceRailStyle(value: number): string {
	const color = CONFIDENCE_COLORS[CONFIDENCE_STOPS.indexOf(value)] ?? CONFIDENCE_COLORS[2]!;
	const images = [
		`linear-gradient(90deg, ${color} 0%, ${color} ${value}%, transparent ${value}%, transparent 100%)`,
		...[30, 50, 70, 90].map(() => "linear-gradient(90deg, rgba(230,230,230,0.35), rgba(230,230,230,0.35))"),
	];
	const sizes = ["100% 100%", "1px 100%", "1px 100%", "1px 100%", "1px 100%"];
	const positions = ["0 0", ...[30, 50, 70, 90].map((p) => `${p}% 0`)];
	return `background-color:#141414;background-image:${images.join(",")};background-size:${sizes.join(",")};background-position:${positions.join(",")};background-repeat:no-repeat`;
}
