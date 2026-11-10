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
import type { AppTool, AppToolResult } from "../../tools/index.ts";
import { invalidInputResult, toToolResult } from "../../tools/index.ts";
import type { AuditVerdicts } from "../model/types.ts";
import { findingsSchema, sessionFindingsSchema } from "../model/findings.ts";
import type { DurableRole, RoleStateIo, SubmitRunState } from "../../jobs/index.ts";
import { auditorGraphTools } from "./graph-tools.ts";
import { stores } from "../../stores.ts";

/** What the extractor SUBMITS — propositions + chains. Chains are stored
 *  AS-IS (chains-primary: no edge translation at any seam). */
type FindingsSubmit = Static<typeof findingsSchema>;

/** The SESSION wire — the notes shape plus the REQUIRED messageId anchor
 *  on every proposition. */
type SessionFindingsSubmit = Static<typeof sessionFindingsSchema>;

// VERDICTS-ONLY (owner decision): the auditor never alters or restates the
// extractor's findings and never mints edges — links are its ENTIRE
// deliverable. The graph connects across sources solely through identified
// equivalences.
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
 *  schema validation) is stripped so notes provenance stays source-level
 *  (the file is the anchor). */
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

/** The chain laws — the LOUD channel: a problem string becomes an error
 *  tool result and the model re-submits within its turns. The MIXED
 *  NAMESPACE: an endpoint resolves when it is a submitted proposition id OR an
 *  existing graph node id (the extractor continues a partly-extracted
 *  source and references digest ids verbatim). Identical (premise-set,
 *  conclusion) chains are NOT errors — they dedupe silently at the
 *  merge (chainKey): restating an argument is a no-op. */
function validateFindingsChains(value: FindingsSubmit, existingIds: ReadonlySet<string>): string | null {
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

/** The SESSION anchor law: every proposition names a
 *  passage of the CURRENT batch — nonempty, and a teacher-prose message
 *  id present in the stretch this extractor is reading (the same ids the
 *  view's TEACHER [id] labels carry). Refused anchors ride the existing
 *  error-back channel: no merge, no coverage checkpoint, until a valid
 *  submit lands. The boundary is strict on purpose — an id from a LATER
 *  or already-covered batch, another chat, or a learner/tool message is
 *  refused even when it is a real message id of this chat. */
function validateSessionAnchors(value: SessionFindingsSubmit, batchIds: ReadonlySet<string>): string | null {
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

const FINDINGS_TOOL = "submit_findings";
const AUDIT_TOOL = "submit_review";

/** One submit tool: validates, commits the accepted value into the run's
 *  role state BEFORE the tool result, and asks the run to stop (a clean
 *  submit ends the loop; a refused one is an error result the model may
 *  retry). */
function submitRoleTool(
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

/** The extraction stages as durable roles: one validated submit ends the
 *  run; the auditor also explores the graph (the run's own, else the app's). */
function submitRole(kind: "extract" | "audit"): DurableRole<SubmitRunState> {
	return {
		initialState: () => ({ kind, submitted: null }),
		submitTool: kind === "audit" ? AUDIT_TOOL : FINDINGS_TOOL,
		tools(run) {
			const submit = submitRoleTool(run.input as unknown as SubmitRunInput, run.state);
			if (kind !== "audit") return { [submit.name]: submit };
			const graph = run.host.graph ?? { chatStore: stores.chatStore, graphStore: stores.graphStore };
			return { ...auditorGraphTools(graph), [submit.name]: submit };
		},
	};
}

export const EXTRACTION_ROLES = { extract: submitRole("extract"), audit: submitRole("audit") };
