/** The quiet home summary's line model: every count on its own line, no
 *  dot separators, graph block then session block then imported notes. */
export interface KnowledgeCounts {
	propositions: number;
	chains: number;
	teachSessions: number;
	practiceSessions: number;
	importedNotes: number;
}

export interface KnowledgeLine {
	text: string;
	block: "graph" | "sessions" | "notes";
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function knowledgeLines(counts: KnowledgeCounts): KnowledgeLine[] {
	return [
		{ text: plural(counts.propositions, "proposition", "propositions"), block: "graph" },
		{ text: plural(counts.chains, "chain", "chains"), block: "graph" },
		{ text: plural(counts.teachSessions, "teaching session", "teaching sessions"), block: "sessions" },
		{ text: plural(counts.practiceSessions, "practice session", "practice sessions"), block: "sessions" },
		{ text: plural(counts.importedNotes, "imported note", "imported notes"), block: "notes" },
	];
}

export function knowledgeEmpty(counts: KnowledgeCounts): boolean {
	return Object.values(counts).every((count) => count === 0);
}
