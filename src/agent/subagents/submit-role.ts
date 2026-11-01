/**
 * The extraction pipeline's submit roles (durable). The extractor and auditor
 * are single-submit workers whose deliverable is ONE TypeBox-validated submit
 * call; the auditor adds graph-exploration tools. This module owns the wire
 * shapes, the weak-model fills and the semantic validators, so the durable
 * role factory can rebuild the exact same tool from the persisted descriptor
 * after a restart — the validated value itself is captured in the run's
 * role state before its tool result (never a closure variable).
 */

import type { JsonObject } from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import type { AppTool, AppToolResult } from "../tool-adapter.ts";
import { invalidInputResult, toToolResult } from "../tool-execute.ts";
import { healEncodedArguments } from "../../core/argument-heal.ts";
import type { AuditVerdicts, SessionFindings } from "../../core/contracts.ts";
import type { RoleStateIo, SubmitRunState } from "./durable-run.ts";

// ── the weak-model string-heal (owner, 2026-09-28; moved here from
// extraction.ts with the digest-aware redesign, 2026-09-30 — the heal
// is wire-format medicine shared by every submit agent) ──
//
// OpenRouter log evidence: weak models under a big submit payload often
// emit a whole array as ONE JSON-STRING instead of a native array
// ("propositions.0: must be object"). pi-agent-core runs
// `prepareArguments` BEFORE TypeBox validation — the sanctioned shim
// point (same doctrine as restoreMathEscapes at the display seam: heal
// weak-model wire behavior, don't punish it with a retry). Best-effort:
// heal only a string that parses to an array; anything else passes
// through untouched and fails validation exactly as before.
export function healStringifiedArrays(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return raw;
	const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
	for (const key of ["propositions", "chains"]) {
		const v = out[key];
		if (typeof v !== "string" || v.trim().length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(v);
			if (Array.isArray(parsed)) out[key] = parsed;
		} catch {
			// not a clean stringify (e.g. truncated) — leave for validation
		}
	}
	return out;
}

// ─── the extractor's wire shapes ─────────────────────────────────────────────

const propositionProps = {
	id: Type.String({ description: 'Local id: "p1", "p2", … — referenced by chains in this call.' }),
	name: Type.String({
		description:
			"A very short label — established terminology, the term the discipline itself uses, a glossary " +
			"headword a textbook would print ('Will to power', 'Divine command theory'). Not a sentence, " +
			"needn't be unique or self-contained: this becomes the node's global label in the graph.",
	}),
	statement: Type.String({
		description:
			"One true, self-contained, world-facing core idea at full precision. Never about the " +
			'learner, the teacher, or the reading: not "the learner understands X" but "X". A misconception ' +
			"enters as its TRUE correction.",
	}),
	aliases: Type.Optional(
		Type.Array(Type.String(), {
			description: "Verbatim phrasings the source used for the same proposition, if any.",
		}),
	),
};

// The extractor redesign (owner, 2026-09-30): the extractor submits
// REASONING CHAINS — premises + conclusion — stored AS-IS (chains-primary,
// same evening: chains.jsonl is the truth; edges are a derived view, and
// supports edges are retired entirely).
const endpoint = (role: string) =>
	Type.String({
		description:
			`The id this ${role} — EITHER an existing graph idea id from THE GRAPH SO FAR in the prompt, ` +
			'verbatim ("n_…"), OR the local id of a proposition in this submission ("p1", …).',
	});

const chainSchema = Type.Object({
	premises: Type.Array(endpoint("premise uses"), {
		minItems: 1,
		description:
			"Premise ids used TOGETHER: they jointly entail the conclusion; independent reasons are separate chains.",
	}),
	conclusion: endpoint("conclusion is"),
});

// Weak-model tolerance (owner, 2026-09-25): the old zod `.default([])` /
// `.default({ quiz: {} })` on required-but-empty fields becomes Type.Optional
// here + a ??-fill at the submit seam (fillFindings/fillAudit below) — same
// contract on the wire (omission tolerated, empty never means "invalid"),
// no zod left in the agent band.
const propositionsDescription =
	"Only the NEW core ideas this stretch contributes — ideas the prompt's THE GRAPH SO FAR already " +
	"holds are referenced by id in chains, never restated here.";
const chainsDescription =
	"Every argument this stretch makes — including arguments that join new ideas to established " +
	"ones; conclusions reusable by id as premises of later chains; bare ideas (no argument) ride " +
	"the propositions list alone; pass [] when none — never omit the field.";

const findingsSchema = Type.Object({
	propositions: Type.Array(Type.Object(propositionProps), {
		description: propositionsDescription,
	}),
	chains: Type.Array(chainSchema, {
		description: chainsDescription,
	}),
});

// THE SESSION EXTENSION (owner, 2026-10-13): every session proposition
// carries a REQUIRED messageId — the anchor of the passage it came from,
// copied from the view's "TEACHER [id]" label (validated at the submit
// seam against the CURRENT batch). The NOTES door has no messages: its
// schema stays the base shape above, prompt and wire unchanged.
const sessionPropositionProps = {
	...propositionProps,
	messageId: Type.String({
		description:
			"The message id of the ONE passage in this stretch that most directly states or explains this " +
			'proposition — copy it EXACTLY from that passage\'s "TEACHER [id]" label.',
	}),
};

const sessionFindingsSchema = Type.Object({
	propositions: Type.Array(Type.Object(sessionPropositionProps), {
		description: propositionsDescription,
	}),
	chains: Type.Array(chainSchema, {
		description: chainsDescription,
	}),
});

/** What the extractor SUBMITS (the redesign's wire shape) — propositions
 *  + chains. fillFindings normalizes it; validateFindingsChains checks
 *  the chain laws; asSessionFindings lifts it straight into
 *  SessionFindings — chains are stored AS-IS (chains-primary, owner
 *  2026-09-30: no edge translation at any seam). */
export type FindingsSubmit = Static<typeof findingsSchema>;

/** The SESSION wire — the notes shape plus the REQUIRED messageId anchor
 *  on every proposition (owner, 2026-10-13). */
type SessionFindingsSubmit = Static<typeof sessionFindingsSchema>;

// VERDICTS-ONLY (owner, 2026-09-28): the auditor never alters the
// extractor's findings, so it does not restate them — links are its
// ENTIRE deliverable (owner, 2026-09-28 evening: the edges argument is
// GONE; the auditor never mints edges. The graph connects across sources
// solely through identified equivalences — a link, never an inference).
const auditSchema = Type.Object({
	links: Type.Array(
		Type.Object({
			id: Type.String({ description: 'The proposition id from the findings ("p1", …).' }),
			linkTo: Type.String({
				description:
					"The id of the EXISTING graph node this proposition IS — your identity verdict. EQUIVALENCE BIAS (2026-09-27): paraphrases, rewordings, and compressions of the same claim MERGE; only genuinely distinct propositions stay apart.",
			}),
		}),
		{ description: "Identity verdicts — which findings propositions ARE existing graph nodes. A proposition absent from here = create a new node. Pass [] when none — never omit the field." },
	),
});

function fillFindings<T extends { propositions: Array<{ aliases?: string[] }>; chains: unknown }>(
	raw: T,
): T {
	return {
		...raw,
		propositions: raw.propositions.map((p) => ({ ...p, aliases: p.aliases ?? [] })),
	};
}

/** The notes fill: the shared alias ??-fill PLUS the door's boundary — a
 *  stray messageId (the notes schema has none; extra properties pass
 *  schema validation) is stripped so notes provenance stays chat-level
 *  (the file is the anchor, owner 2026-09-13). */
function fillNotesFindings(raw: FindingsSubmit): FindingsSubmit {
	return fillFindings({
		...raw,
		propositions: raw.propositions.map((p) => {
			const stripped = { ...p } as typeof p & { messageId?: unknown };
			delete stripped.messageId;
			return stripped;
		}),
	});
}

/** The chain laws (extractor redesign, 2026-09-30; digest-aware
 *  2026-09-30 evening) — the LOUD channel: runSubmitAgent turns a
 *  problem string into an error tool result and the model re-submits
 *  within its turns. The MIXED NAMESPACE: an
 *  endpoint resolves when it is a submitted proposition id OR an
 *  existing graph node id (the extractor continues a partly-extracted
 *  source and references digest ids verbatim). Identical (premise-set,
 *  conclusion) chains are NOT errors — they dedupe silently at the
 *  merge (chainKey): restating an argument is a no-op. */
export function validateFindingsChains(value: FindingsSubmit, existingIds: ReadonlySet<string>): string | null {
	const ids = new Set(value.propositions.map((p) => p.id));
	for (const chain of value.chains) {
		if (chain.premises.length === 0) {
			return "chains: premises must name at least one proposition — a proposition with no argument stays in the propositions list alone.";
		}
		const unknown = [...chain.premises, chain.conclusion].find((id) => !ids.has(id) && !existingIds.has(id));
		if (unknown !== undefined) {
			return `chains: "${unknown}" is neither a submitted proposition id nor an existing idea id from THE GRAPH SO FAR — every premise and conclusion must resolve.`;
		}
		if (chain.premises.includes(chain.conclusion)) {
			return "chains: a conclusion cannot be its own premise.";
		}
	}
	return null;
}

/** The SESSION anchor law (owner, 2026-10-13): every proposition names a
 *  passage of the CURRENT batch — nonempty, and a teacher-prose message
 *  id present in the stretch this extractor is reading (the same ids the
 *  view's TEACHER [id] labels carry). Refused anchors ride the existing
 *  error-back channel: no merge, no coverage checkpoint, until a valid
 *  submit lands. The boundary is strict on purpose — an id from a LATER
 *  or already-covered batch, another chat, or a learner/tool message is
 *  refused even when it is a real message id of this chat. */
export function validateSessionAnchors(value: SessionFindingsSubmit, batchIds: ReadonlySet<string>): string | null {
	for (const p of value.propositions) {
		if (p.messageId.trim().length === 0) {
			return `propositions: "${p.id}" is missing its messageId — copy the message id from the brackets of the passage (TEACHER [id]) that most directly states or explains it.`;
		}
		if (!batchIds.has(p.messageId)) {
			return `propositions: "${p.id}" names messageId "${p.messageId}", which is not a passage of THIS stretch — copy the id from the brackets of one of this stretch's own TEACHER [id] passages.`;
		}
	}
	return null;
}

function fillAudit(raw: Static<typeof auditSchema>): AuditVerdicts {
	return {
		links: raw.links,
	};
}

// ─── the role tool built from the persisted descriptor ──────────────────────

/** Which submit wire one durable run speaks. Persisted as `input.submit`. */
export type SubmitVariant = "session-findings" | "notes-findings" | "audit";

/** The persisted, closure-free configuration of one submit run. */
export interface SubmitRunInput {
	submit: SubmitVariant;
	/** The session extractor's allowed passage anchors. */
	batchIds?: string[];
	/** The graph node ids visible when the run started (mixed namespace). */
	existingIds: string[];
}

export const FINDINGS_TOOL = "submit_findings";
export const AUDIT_TOOL = "submit_review";

/** One submit tool: validates, commits the accepted value into the run's
 *  role state BEFORE the tool result, and asks the run to stop — the old
 *  `shouldStop` law (a clean submit ends the loop; a refused one is an
 *  error result the model may retry). */
export function submitRoleTool(
	input: SubmitRunInput,
	io: RoleStateIo<SubmitRunState>,
): AppTool<any> {
	const existingIds = new Set(input.existingIds);
	const batchIds = new Set(input.batchIds ?? []);
	const audit = input.submit === "audit";
	const toolName = audit ? AUDIT_TOOL : FINDINGS_TOOL;
	const parameters = audit
		? auditSchema
		: input.submit === "notes-findings"
			? findingsSchema
			: sessionFindingsSchema;
	const validate = (value: unknown): string | null => {
		if (audit) return null;
		if (input.submit === "notes-findings") {
			return validateFindingsChains(value as FindingsSubmit, existingIds);
		}
		return (
			validateSessionAnchors(value as SessionFindingsSubmit, batchIds) ??
			validateFindingsChains(value as FindingsSubmit, existingIds)
		);
	};
	return {
		name: toolName,
		description: audit
			? "Submit the identity verdicts ONLY (links) — never the propositions themselves."
			: input.submit === "notes-findings"
				? "Submit the notes findings."
				: "Submit the session findings.",
		parameters,
		prepareArguments: (args: unknown) => healEncodedArguments(healStringifiedArrays(args), parameters),
		executionMode: "sequential",
		async execute(_toolCallId, raw): Promise<AppToolResult> {
			const value = audit
				? fillAudit(raw as Static<typeof auditSchema>)
				: input.submit === "notes-findings"
					? fillNotesFindings(raw as FindingsSubmit)
					: fillFindings(raw as SessionFindingsSubmit);
			const problem = validate(value);
			if (problem) return invalidInputResult(toolName, [problem]) as AppToolResult;
			await io.update((state) => {
				state.submitted = value as unknown as JsonObject;
			});
			return { ...(toToolResult(value) as AppToolResult), terminate: true };
		},
	};
}

/** The pipeline's lift of a submitted session shape into SessionFindings
 *  (aliases filled; the messageId anchor preserved, 2026-10-13). */
export function asSessionFindings(raw: unknown): SessionFindings {
	const value = raw as {
		propositions: Array<{ id: string; name: string; statement: string; aliases?: string[]; messageId?: string }>;
		chains: Array<{ premises: string[]; conclusion: string }>;
	};
	return {
		propositions: value.propositions.map((p) => ({ ...p, aliases: p.aliases ?? [] })),
		chains: value.chains,
	};
}
