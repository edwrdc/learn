/** Reading-font menu and composer (pure): row-set and factory semantics. */
import { fuzzyScore } from "@/src/platform/model";
import type { AppearanceSettings } from "@/src/settings/model";

export const DEFAULT_READING_FONT = "Source Sans 3";
export const CURATED_FALLBACK_FONTS = [
	"Arial",
	"CMU Serif",
	"Courier New",
	"Georgia",
	"Helvetica",
	"Helvetica Neue",
	"Menlo",
	"Times New Roman",
	"Trebuchet MS",
	"Verdana",
];

export function fontMenuResults(query: string, families: string[]): Array<string | null> {
	const scored = families
		.map((family) => ({ family, score: fuzzyScore(query, family) }))
		.filter((row): row is { family: string; score: number } => row.score !== null)
		.sort((a, b) => b.score - a.score || a.family.localeCompare(b.family))
		.map((row) => row.family);
	const defaultScore = fuzzyScore(query, DEFAULT_READING_FONT, "default");
	return query.trim() === "" || defaultScore !== null ? [null, ...scored] : scored;
}

export function customFamilyFor(query: string, families: string[]): string | null {
	const trimmed = query.trim();
	if (trimmed === "") return null;
	return fontMenuResults(query, families).length === 0 ? trimmed : null;
}

export function composeFontFamily(
	appearance: AppearanceSettings | undefined,
	family: string | null,
): AppearanceSettings {
	const value = family?.trim() ?? "";
	return { ...appearance, fontFamily: value === "" ? null : value };
}
