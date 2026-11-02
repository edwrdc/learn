/** The conclude card's metadata rows (the old MetadataPopover data seam). */
export interface PracticeMetaInputs {
	conclude: { outcome?: string; rung?: unknown; missClass?: unknown; retest?: unknown };
	problem: { mode?: unknown; target?: unknown };
	names?: Record<string, string> | null;
}

export interface MetaRow {
	label: string;
	value: string;
}

export function practiceTargets(problem: { target?: unknown }): string[] {
	return Array.isArray(problem.target) ? problem.target.filter((target): target is string => typeof target === "string") : [];
}

export function hasPracticeMeta(inputs: PracticeMetaInputs): boolean {
	const mode = typeof inputs.problem.mode === "string" ? inputs.problem.mode : "";
	const rung = typeof inputs.conclude.rung === "string" ? inputs.conclude.rung : "";
	const miss = typeof inputs.conclude.missClass === "string" ? inputs.conclude.missClass : "";
	const retest = typeof inputs.conclude.retest === "boolean" ? inputs.conclude.retest : undefined;
	return mode !== "" || practiceTargets(inputs.problem).length > 0 || rung !== "" || miss !== "" || retest !== undefined;
}

export function practiceMetaRows(inputs: PracticeMetaInputs): MetaRow[] {
	const mode = typeof inputs.problem.mode === "string" ? inputs.problem.mode : "";
	const targets = practiceTargets(inputs.problem);
	const rung = typeof inputs.conclude.rung === "string" ? inputs.conclude.rung : "";
	const miss = typeof inputs.conclude.missClass === "string" ? inputs.conclude.missClass : "";
	const retest = typeof inputs.conclude.retest === "boolean" ? inputs.conclude.retest : undefined;
	const outcome = typeof inputs.conclude.outcome === "string" ? inputs.conclude.outcome : "";
	return [
		{ label: "Mode", value: mode || "—" },
		{ label: "Targets", value: targets.length === 0 ? "untagged" : targets.map((target) => inputs.names?.[target] ?? target).join(", ") },
		{ label: "Outcome", value: outcome || "—" },
		{ label: "Hint rung", value: rung || "none" },
		{ label: "Miss class", value: miss || "none" },
		{ label: "Retest", value: retest === undefined ? "—" : retest ? "yes" : "no" },
	];
}
