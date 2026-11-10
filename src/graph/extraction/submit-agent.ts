/**
 * runSubmitAgent — the shared single-submit runner for the extraction
 * stages (the durable port of the old pi-agent loop). One TypeBox-validated
 * submit call is the whole deliverable; the model may retry a
 * schema-invalid call, and the auditor may explore the graph first.
 *
 * The loop is a durable conversation (durable-run.ts): the submitted value
 * is committed into the run descriptor's role state BEFORE its tool result,
 * so a restart reattaches the same conversation (same request id) instead of
 * billing another copy, and a process that died after the submit reads the
 * captured value back instead of asking again.
 */

import type { JsonObject } from "@earendil-works/pi-durable";
import type { Usage } from "@earendil-works/pi-ai";
import type { ModelRole } from "../../settings/model/index.ts";
import type { PiEngine } from "../../platform/index.ts";
import {
	backgroundRun,
	retireBackgroundRun,
	type RoleRunIdentity,
	type SubmitRunState,
} from "../../jobs/index.ts";
import type { GraphDeps } from "../snapshot.ts";
import type { SubmitRunInput, SubmitVariant } from "./submit-role.ts";


export async function runSubmitAgent<T>(opts: {
	role: ModelRole;
	/** Which submit wire this run speaks. */
	variant: SubmitVariant;
	systemPrompt: string;
	prompt: string;
	engine: PiEngine | undefined;
	signal: AbortSignal | undefined;
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void;
	neverSubmitted: string;
	/** Turn budget (default 4 = retry-only; the auditor runs an exploration
	 *  loop instead — 16). */
	maxTurns?: number;
	/** The graph node ids visible when the run starts. */
	existingIds: readonly string[];
	/** The session extractor's allowed passage anchors. */
	batchIds?: readonly string[];
	/** The durable owner + stable run key (source id + job identity). */
	run: RoleRunIdentity;
	/** The live graph the auditor explores (tests inject their ledgers). */
	graph?: GraphDeps;
}): Promise<T> {
	if (!opts.engine) throw new Error("submit agent: no model engine was resolved");
	const input: SubmitRunInput = {
		submit: opts.variant,
		...(opts.batchIds ? { batchIds: [...opts.batchIds] } : {}),
		existingIds: [...opts.existingIds],
	};
	let outcome;
	let consumed = true;
	try {
		outcome = await backgroundRun({
		jobId: opts.run.jobId,
		chatId: opts.run.chatId,
		kind: opts.variant === "audit" ? "audit" : "extract",
		role: opts.role,
		engine: opts.engine,
		maxTurns: opts.maxTurns ?? 4,
		systemPrompt: opts.systemPrompt,
		prompt: opts.prompt,
		input: input as unknown as JsonObject,
		graph: opts.graph,
		signal: opts.signal,
		onStep: (step) =>
			opts.onStep(step.usage, step.model, step.step, step.finishReason, step.tools),
		});
	} catch (error) {
		// A runtime close is a recoverable process death: the run stays
		// indexed for the restart to reattach. An abort is marked failed by
		// the runner, so it is safe to leave it too.
		consumed = !(error instanceof Error && error.name === "AbortError");
		throw error;
	} finally {
		// The caller holds the value/error now: a later identical stage is a
		// new run. A process death before this line leaves the run indexed.
		if (consumed) await retireBackgroundRun(opts.run.chatId, opts.run.jobId).catch(() => undefined);
	}
	const submitted = (outcome.state as SubmitRunState).submitted;
	if (submitted === null || submitted === undefined) throw new Error(opts.neverSubmitted);
	return submitted as T;
}
