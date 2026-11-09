/**
 * The agents' prompt segments and the user's overrides of them.
 *
 * SEGMENTS: the shared base (system-prompt.md), then every numeric-prefix
 * *.md fragment in the agent's own directory (sorted by filename), then the
 * shared/ fragments as a trailing appendix. The list is read from the source
 * tree at runtime, so an override keyed to a segment the source no longer
 * ships stops composing automatically.
 *
 * OVERRIDES: files mirror the source layout under PROMPTS_OVERRIDE_DIR.
 * File presence is NOT the override: the settings switch (agent.prompts) is,
 * so a user can keep a file and flip back to the source default to compare.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS, PROMPTS_OVERRIDE_DIR, writeFileAtomic } from "../platform/index.ts";
import { FRAGMENT_RE, isValidSegmentPath, type AgentSettings, type PromptAgent, type PromptSegmentInfo } from "../settings/model/index.ts";
import { readSettings, writeSettings } from "../settings/index.ts";

const PROMPTS_DIR = path.join(PATHS.root, "src", "session", "prompts");

/** Shared fragments the PRACTICE agent composes: the VOICE, ACCURACY,
 *  and MENTAL-MODEL chunks joined the formatting guide (owner rounds 13
 *  and the prompt-refinement round of 2026-10-07) — personality, the
 *  truth contract, and the thinking-fields doctrine are ONE law across
 *  every agent. The question/confidence/file mechanics stay out
 *  (practice has no such tools). */
const PRACTICE_SHARED_FRAGMENTS = ["10-voice.md", "15-accuracy.md", "16-mental-model.md", "40-formatting.md"];

/** Absolute path for an override file (unchecked — validate first). */
function overrideFileFor(segmentPath: string): string {
	return path.join(PROMPTS_OVERRIDE_DIR, ...segmentPath.split("/"));
}

/** The override files: only valid segment paths are read or written. */
export const promptOverrides = {
	/** Every override path on disk, POSIX-relative, sorted. */
	listOverrides(): string[] {
		const out: string[] = [];
		const walk = (dir: string, prefix: string) => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return; // no dir yet = no overrides
			}
			for (const entry of entries) {
				const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
				if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
				else if (entry.isFile() && entry.name.endsWith(".md") && isValidSegmentPath(rel)) out.push(rel);
			}
		};
		walk(PROMPTS_OVERRIDE_DIR, "");
		return out.sort();
	},
	readOverride(segmentPath: string): string | null {
		if (!isValidSegmentPath(segmentPath)) return null;
		try {
			return fs.readFileSync(overrideFileFor(segmentPath), "utf-8");
		} catch {
			return null;
		}
	},
	writeOverride(segmentPath: string, text: string): void {
		if (!isValidSegmentPath(segmentPath)) return;
		writeFileAtomic(overrideFileFor(segmentPath), text);
	},
	/** Remove the override file if present; the switch is untouched. */
	deleteOverride(segmentPath: string): void {
		if (!isValidSegmentPath(segmentPath)) return;
		try {
			fs.unlinkSync(overrideFileFor(segmentPath));
		} catch {
			// absent already = done
		}
	},
};

/** List the SOURCE segments for one agent, in composition order — the
 *  shared base, then the agent's own fragments sorted by filename, then
 *  the shared/ fragments (the 2026-09-27 reorder: the agent's job and
 *  method lead; the shared tool/file/format mechanics are an appendix).
 *  The exact order composeInstructions composes them in. */
export function listSourceSegments(agent: PromptAgent): Array<{ path: string; shared: boolean; file: string }> {
	// PRACTICE (owner, 2026-10-04): its own directory plus a CURATED
	// shared appendix — the teaching base and the question/confidence/
	// file mechanics stay out (the doctrine contradicts them; 00-base.md
	// plays the base role), but the FORMATTING guide composes for every
	// agent (owner, 2026-10-04 late): LaTeX delimiters and markdown apply
	// in all settings — practice shares the $...$/$$...$$ authoring contract.
	const segments: Array<{ path: string; shared: boolean; file: string }> = agent === "practice" ? [] : [
		{ path: "system-prompt.md", shared: true, file: PATHS.teacherPrompt },
	];
	const dir = path.join(PROMPTS_DIR, agent);
	if (fs.existsSync(dir)) {
		const fragments = fs.readdirSync(dir).filter((f) => FRAGMENT_RE.test(f)).sort();
		for (const f of fragments) {
			segments.push({ path: `${agent}/${f}`, shared: false, file: path.join(dir, f) });
		}
	}
	const sharedDir = path.join(PROMPTS_DIR, "shared");
	if (fs.existsSync(sharedDir)) {
		// The practice allowlist (owner, 2026-10-04 late): formatting only.
		const allow = agent === "practice" ? PRACTICE_SHARED_FRAGMENTS : null;
		const sharedFragments = fs
			.readdirSync(sharedDir)
			.filter((f) => FRAGMENT_RE.test(f) && (allow === null || allow.includes(f)))
			.sort();
		for (const f of sharedFragments) {
			segments.push({ path: `shared/${f}`, shared: true, file: path.join(sharedDir, f) });
		}
	}
	return segments;
}

/**
 * The effective segment view for one agent — every segment with its source
 * text, override text, and effective switch state. `switches` is the
 * settings record's agent.prompts map (absent key = off); enabled =
 * switch on AND the override file exists.
 */
export function effectivePromptSegments(
	agent: PromptAgent,
	switches: Record<string, boolean>,
): PromptSegmentInfo[] {
	return listSourceSegments(agent).map((segment) => {
		let sourceText: string;
		try {
			sourceText = fs.readFileSync(segment.file, "utf-8");
		} catch {
			sourceText = ""; // source unreadable — the agent loader would crash anyway
		}
		const overrideText = promptOverrides.readOverride(segment.path);
		return {
			path: segment.path,
			sourceText,
			overrideText,
			enabled: switches[segment.path] === true && overrideText !== null,
			shared: segment.shared,
		};
	});
}

/** Every known segment path across both agents (route validation). */
export function allSegmentPaths(): string[] {
	const paths = new Set<string>();
	for (const agent of ["prober", "teacher", "practice"] as const) {
		for (const segment of listSourceSegments(agent)) paths.add(segment.path);
	}
	return [...paths].sort();
}

/** Write a segment's override text; only a current source segment takes one
 *  (anything else is a typo or a vanished fragment, never a silent orphan). */
export function writePromptOverride(segmentPath: string, text: string): { ok: true } | { ok: false; error: string; supported: string[] } {
	const segments = allSegmentPaths();
	if (!segments.includes(segmentPath)) return { ok: false, error: `"${segmentPath}" is not a current source segment`, supported: segments };
	promptOverrides.writeOverride(segmentPath, text);
	return { ok: true };
}

/** Remove a segment's override and its switch together, so no ON switch is
 *  left pointing at a missing file. The switch goes first: a crash between
 *  the two leaves "off + file", a valid state. */
export function deletePromptOverride(segmentPath: string): { switchCleared: boolean } {
	const record = readSettings();
	const prompts = record?.agent?.prompts;
	const switchCleared = prompts?.[segmentPath] === true;
	if (record?.agent && prompts && prompts[segmentPath] !== undefined) {
		const { [segmentPath]: _dropped, ...rest } = prompts;
		writeSettings({ ...record, agent: { ...record.agent, prompts: rest } });
	}
	promptOverrides.deleteOverride(segmentPath);
	return { switchCleared };
}

/** An ON switch whose override file is gone (or whose segment left the
 *  source tree) is written as OFF, so a settings write never gets stuck on
 *  a wiped override. */
export function healPromptSwitches(agent: AgentSettings): AgentSettings {
	const segments = new Set(allSegmentPaths());
	const orphans = Object.entries(agent.prompts ?? {})
		.filter(([segmentPath, on]) => on && (!segments.has(segmentPath) || promptOverrides.readOverride(segmentPath) === null))
		.map(([segmentPath]) => segmentPath);
	if (orphans.length === 0) return agent;
	console.info(`[settings] healed orphaned prompt switch(es) to off: ${orphans.join(", ")}`);
	const prompts = Object.fromEntries(Object.entries(agent.prompts ?? {}).filter(([segmentPath]) => !orphans.includes(segmentPath)));
	return { ...agent, prompts };
}
