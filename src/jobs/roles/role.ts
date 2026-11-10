import { isAbortError } from "../../platform/model/index.ts";
/**
 * A background role, defined once: what its conversation runs (prompt,
 * tools, durable hooks, initial state) and, for a job role, how a job's
 * input becomes a run and the run becomes the job's result.
 */

import type { JsonObject } from "@earendil-works/pi-durable";
import type { ModelRole } from "../../settings/model/index.ts";
import type { JobKind, SearchProvider } from "../../tools/model/index.ts";
import type { AppTool } from "../../tools/index.ts";
import type { PiEngine } from "../../platform/index.ts";
import type { GraphDeps } from "../../graph/index.ts";
import {
	backgroundRun,
	backgroundServices,
	type BackgroundRunResult,
	type RoleMessageContent,
	type RoleRunIdentity,
	type RoleStateIo,
	type RunState,
	RunFailure,
} from "../durable-run.ts";
import type { JobResult, JobUsage } from "../model/types.ts";
import { realHeadless, type HeadlessApi } from "../headless.ts";

/** What a role's tools and hooks may reach. */
export interface RoleHost {
	headless: HeadlessApi;
	search: () => SearchProvider | null;
	/** The graph the caller passed with the run (extraction), if any. */
	graph?: GraphDeps;
	onActivity?: (line: string) => void;
}

/** One live role conversation, as its tools and hooks see it. */
export interface RoleRun<S extends RunState> {
	/** The run's stored input (the descriptor's `input`). */
	input: JsonObject;
	maxTurns: number;
	state: RoleStateIo<S>;
	host: RoleHost;
	/** Model calls the run has completed so far. */
	turnsTaken(): Promise<number>;
	/** Record that the turn budget ended the run. */
	markCapped(): Promise<void>;
	/** Whether the run's conversation already holds this user message. */
	hasUserMessage(text: string): Promise<boolean>;
}

export interface DurableRole<S extends RunState> {
	initialState(): S;
	tools(run: RoleRun<S>): Record<string, AppTool<any>>;
	/** After each tool round, before the turn-cap check. */
	afterTools?(run: RoleRun<S>): Promise<void>;
	/** At the model's answer: a message to continue with, or undefined to finish. */
	onYield?(run: RoleRun<S>): Promise<RoleMessageContent | undefined>;
	/** A clean result from this tool ends the run. */
	submitTool?: string;
}

export interface JobRole<I, R extends JobResult, S extends RunState> extends DurableRole<S> {
	kind: JobKind;
	model: ModelRole;
	maxTurns: number;
	instructions: string;
	/** The job's activity line while the run starts. */
	activity: string;
	/** The dispatch input, defaulted (a recovered job reads it from the transcript). */
	input(raw: Partial<I> | undefined): I;
	/** A reason that stops the job before any model call. */
	precheck?(input: I, host: RoleHost): Promise<string | null>;
	prompt(input: I): string;
	/** Adds what the run needs while it lives to the stored input. */
	workspace?<T>(run: (extra: JsonObject) => Promise<T>): Promise<T>;
	/** The run's outcome as the job's result (success or failure). */
	finish(input: I, outcome: BackgroundRunResult & { state: S; maxTurns: number }, host: RoleHost): Promise<R>;
	failure(input: I, reason: string, state?: S): R;
	/** How a crash reads in the failure reason ("the builder crashed"). */
	crashed?: string;
}

interface RoleRunOptions {
	engine: PiEngine;
	run: RoleRunIdentity;
	headless?: HeadlessApi;
	search?: () => SearchProvider | null;
	maxTurns?: number;
	/** The job's kill switch: aborting stops the run. */
	signal?: AbortSignal;
	onActivity?: (line: string) => void;
	onUsage?: (usage: JobUsage) => void;
}

/** The services a role reaches: the caller's own, else the configured ones,
 *  else the app's real headless engine and no search. */
export function roleHost(options: { headless?: HeadlessApi; search?: () => SearchProvider | null; graph?: GraphDeps; onActivity?: (line: string) => void }): RoleHost {
	return {
		headless: options.headless ?? backgroundServices().headless?.() ?? realHeadless,
		search: options.search ?? (() => backgroundServices().searchProvider?.() ?? null),
		graph: options.graph,
		onActivity: options.onActivity,
	};
}

/** Run one job role to its result. A failure becomes the role's failure
 *  result; an abort or a runtime close rethrows as an AbortError (the run
 *  stays recoverable and the abort path owns the job). */
export async function runRole<I, R extends JobResult, S extends RunState>(
	role: JobRole<I, R, S>,
	input: I,
	options: RoleRunOptions,
): Promise<R> {
	const host = roleHost(options);
	const blocked = await role.precheck?.(input, host);
	if (blocked) return role.failure(input, blocked);
	const start = (extra: JsonObject) =>
		backgroundRun({
			jobId: options.run.jobId,
			chatId: options.run.chatId,
			kind: role.kind,
			role: role.model,
			engine: options.engine,
			maxTurns: options.maxTurns ?? role.maxTurns,
			systemPrompt: role.instructions,
			prompt: role.prompt(input),
			input: { ...(input as JsonObject), ...extra },
			headless: host.headless,
			search: host.search,
			signal: options.signal,
			onActivity: options.onActivity,
			onUsage: options.onUsage,
		});
	let outcome: BackgroundRunResult;
	try {
		outcome = role.workspace ? await role.workspace(start) : await start({});
	} catch (error) {
		if (isAbortError(error)) throw error;
		const message = error instanceof Error ? error.message : String(error);
		const state = error instanceof RunFailure ? (error.state as S) : undefined;
		return role.failure(input, role.crashed ? `${role.crashed} — ${message}` : message, state);
	}
	return role.finish(input, { ...(outcome as BackgroundRunResult & { state: S }), maxTurns: options.maxTurns ?? role.maxTurns }, host);
}
