/**
 * One chat turn over the DURABLE record (pi-durable foreground runtime).
 * Framework-free (plain Request/Response) so tests drive it directly.
 *
 * THE INPUT-EVENTS CONTRACT is unchanged: POST /api/chat carries
 * {chatId, input} — one explicit event, never a client transcript. This
 * module is the TURN COMPOSITION ROOT: it turns the event into durable
 * transcript writes, configures the conversation for the turn (model,
 * prompt, tool set), submits the input that starts the durable run, and
 * hands the run's view to the SSE layer.
 *
 * Answers are effective tool results: the learner's answer REPLACES the
 * posed question's committed placeholder result through a ContextEdit, and
 * a hidden continuation input (dropped from every provider request by the
 * request hook) starts the reaction run. A dismissal writes the same
 * replacement and starts nothing.
 *
 * The same composition serves client requests and the wake pipeline's
 * server-side steers (src/server/jobs.ts).
 */

import { ConversationBusy } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { createJobRunner } from "../agent/subagents/runner.ts";
import { createExtractionPipeline } from "../agent/subagents/extraction.ts";
import type { ModelRole } from "../../config.ts";
import {
	deliverJobResult,
	markSteerDelivered,
	noteSteerVisible,
	repumpSteers,
	setJobRespawn,
	setTurnRunner,
	settleSteers,
} from "./jobs.ts";
import { providerEventNote } from "../agent/provider-events.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { searchAvailable, searchProvider } from "./search.ts";
import { providerKeyPresent } from "./keys.ts";
import { CUSTOM_ENDPOINT_PROVIDER_ID } from "../core/custom-endpoint.ts";
import {
	extractionEnabled,
	resolveConversationSpec,
	resolveRoleSpec,
} from "../core/settings-resolution.ts";
import { modelsNotConfigured, providerKeyMissing as providerKeyMissingEnvelope } from "../core/settings.ts";
import { beginTurn, endTurn, noteTurnSettled, noteTurnStarted } from "./turn-liveness.ts";
import { applyParkedDismissal } from "./dismissal-park.ts";
import { registerTurn, settledTurnResponse, unregisterTurn } from "./turn-runs.ts";
import {
	appendPlanBlocks,
	appendRunUsage,
	answerWrite,
	applyAnswer,
	triggerExtraction,
} from "./turn-service.ts";
import { danglingQuestionOf } from "../core/native-messages.ts";
import { composeInstructions } from "../agent/teacher-agent.ts";
import { ensureCompacted, kickCompaction, effectiveThresholdTokens } from "./compaction.ts";
import { catalogContextLimits } from "./model-catalog.ts";
import { syncCustomEndpointProvider, customEndpointKeyPresent } from "./custom-endpoint.ts";
import { emit } from "../core/events.ts";
import {
	ChatInputError,
	inputAppends,
	parseChatInput,
	type TurnInput,
} from "../core/input-events.ts";
import { steerDelivered } from "../core/contracts.ts";
import type { SteerMessage } from "../core/contracts.ts";
import type { LhMessage } from "../core/native-messages.ts";
import {
	CONTINUATION_KIND,
	CONTINUATION_TEXT,
	appendMessages,
	modelTextOf,
	openChatRuntime,
	projectEntries,
	readEntries,
	type ChatRuntime,
} from "../store/durable.ts";
import { chatPhase, prepareConversation, type ConversationDeps } from "./durable-registry.ts";
import { runDurableTurn } from "./pi/durable-turn.ts";

const jobRunner = createJobRunner({
	chatStore: stores.chatStore,
	jobStore: stores.jobStore,
	deliver: deliverJobResult,
	// BYOK (owner, 2026-09-22): job engines resolve the chain — role
	// override → slot → NOTHING — read FRESH per job (a settings PUT
	// between dispatch and spawn lands); an empty chain flows through as
	// undefined and the runner refuses the spawn honestly.
	engineFor: (role) => resolveEngine(role),
	// Key-presence gate (provider-key interlude, 2026-09-25): the runner
	// reads the resolved engine's provider and asks THIS check (the agent
	// layer may not read the key store); a missing key refuses the spawn
	// with the 503-envelope family instead of dying mid-run.
	providerKeyMissing: (provider, tier) =>
		providerHasKey(provider) ? null : providerKeyMissingEnvelope(provider, [tier]),
	// Search port wave (2026-09-20): the researcher's web_search runs on the
	// injected port — resolved FRESH per job (key rotations land immediately).
	searchProvider,
});
/** The app's ONE extraction pipeline instance — both front doors share it:
 *  quiz-triggered session runs (turn-service) and notes imports
 *  (/api/graph/import) hit the same single-flight registry. */
export const extraction = createExtractionPipeline({
	...stores,
	engineFor: (role) => resolveEngine(role),
	providerKeyMissing: (provider, tier) =>
		providerHasKey(provider) ? null : providerKeyMissingEnvelope(provider, [tier]),
});

// Wake-pipeline wiring (contracts.ts "THE ASYNC PROTOCOL" §4): the pipeline
// delivers its steers through THIS composition root (one event: the steer
// markers, appended natively under the turn claim), and crash recovery
// re-spawns orphaned sub-agent loops through THIS runner.
setTurnRunner(async (chatId, input) => {
	const res = await handleChatInput(chatId, input);
	return res.status;
});

function providerHasKey(provider: string): boolean {
	return provider === CUSTOM_ENDPOINT_PROVIDER_ID ? customEndpointKeyPresent() : providerKeyPresent(provider);
}

/** The settings-resolved engine for one role — BYOK (owner, 2026-09-22):
 *  the chain (role override → slot → NOTHING) may end empty, and undefined
 *  flows through to the per-need refusal gates (runner/extraction), read
 *  FRESH so a settings PUT between dispatch and spawn lands. */
function resolveEngine(role: ModelRole): PiEngine | undefined {
	syncCustomEndpointProvider();
	const spec = resolveRoleSpec(role, stores.settingsStore.readSettings());
	if (!spec) return undefined;
	try {
		return piEngineForSpec(spec);
	} catch (error) {
		console.info(`[models] no engine for role ${role}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

setJobRespawn((jobId) => void jobRunner.runJob(jobId));

/** Test injection for the durable turn: a scripted engine, the tools'
 *  composition seams (a job runner whose spawn/deliver a test owns), or a
 *  test-authored tool registry (the loop/protocol suites drive narrow tool
 *  sets; the composition root still installs them through the one adapter). */
export interface ChatTurnInjection {
	engine?: PiEngine;
	deps?: Partial<ConversationDeps>;
	tools?: Record<string, unknown>;
}

/** The route-facing entry: parse {chatId, input} and run one turn. */
export async function handleChatRequest(req: Request, turn?: ChatTurnInjection): Promise<Response> {
	let body: { chatId?: unknown; input?: unknown };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const chatId = typeof body.chatId === "string" ? body.chatId : "";
	if (!chatId) return Response.json({ error: "Unknown chat" }, { status: 404 });
	let input: TurnInput;
	try {
		input = parseChatInput(body.input);
	} catch (err) {
		if (err instanceof ChatInputError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		throw err;
	}
	return handleChatInput(chatId, input, turn);
}

/** The tools' seams (the composition root's wiring). */
function conversationDeps(turn?: ChatTurnInjection): ConversationDeps {
	return {
		chatStore: stores.chatStore,
		graphStore: stores.graphStore,
		jobStore: stores.jobStore,
		spawn: (job, jobInput) => void jobRunner.runJob(job.id, jobInput),
		deliver: (steer) => void deliverJobResult(steer as SteerMessage),
		searchAvailable,
		graphNodes: () => stores.graphStore.readNodes().map((node) => ({ id: node.id, name: node.name })),
		...turn?.deps,
	};
}

/** The submission an input places: the message's model text is the input
 *  content; the record keeps the app shape in entry data. */
function submissionOf(message: LhMessage): {
	content: string;
	entry: { kind: string; data: unknown };
} {
	if (message.role === "custom") {
		return {
			content: modelTextOf(message) ?? "",
			entry: { kind: "lh.marker", data: { message } },
		};
	}
	return {
		content: typeof message.content === "string" ? message.content : "",
		entry: { kind: "lh.user", data: { id: message.id } },
	};
}

/** A record message that can start a run as the submitted input (a user
 *  turn or a model-facing marker). Tool results and assistants cannot. */
function startsInput(message: LhMessage | undefined): message is LhMessage {
	if (!message) return false;
	if (message.role === "custom") return modelTextOf(message) !== null;
	return message.role === "user";
}

/** The turn composition: one input event → durable writes → one durable run. */
export async function handleChatInput(
	chatId: string,
	input: TurnInput,
	turn?: ChatTurnInjection,
): Promise<Response> {
	let record = await stores.chatStore.getChat(chatId);
	if (!record) {
		return Response.json({ error: "Unknown chat" }, { status: 404 });
	}

	// THE UNIVERSAL TURN GATE (BYOK, owner, 2026-09-22): a turn needs the
	// CONVERSATION chain — the chat's own model override over the strong
	// slot — and there is no factory floor; when both are empty the turn
	// refuses honestly with the machine-readable 503 envelope (new sessions
	// and continuing ones alike — wake-pipeline turns ride this same path).
	const effective = effectiveSettings();
	const conversation = resolveConversationSpec(record.settings, effective.models.strong);
	if (!conversation) {
		const envelope = modelsNotConfigured(["strong"]);
		console.info(`[chat ${chatId}] turn refused — ${JSON.stringify(envelope)}`);
		return Response.json(envelope, { status: 503 });
	}

	// THE KEY-PRESENCE GATE (provider-key interlude, owner, 2026-09-25): a
	// pinned model is not enough — its PROVIDER's key must be present, or
	// the turn dies mid-stream masked to a generic error. Truth is env-first
	// (providerKeyPresent reads what pi-ai would read at request time), so
	// an env-shadowed key passes.
	if (!providerHasKey(conversation.provider)) {
		const envelope = providerKeyMissingEnvelope(conversation.provider, ["strong"]);
		console.info(`[chat ${chatId}] turn refused — ${JSON.stringify(envelope)}`);
		return Response.json(envelope, { status: 503 });
	}

	// The engine is the app's one provider adapter (models.ts): production
	// resolves the chat's spec (the custom endpoint's provider + credential
	// snapshot is captured here), tests inject a scripted engine.
	syncCustomEndpointProvider();
	let engine: PiEngine;
	try {
		engine = turn?.engine ?? piEngineForSpec(conversation);
	} catch (error) {
		console.error(`[chat ${chatId}] model unavailable:`, error);
		return Response.json(
			{
				error: "The selected model is no longer available — update your model settings",
				code: "model_unavailable",
			},
			{ status: 503 },
		);
	}

	const runtime = await openChatRuntime(chatId);
	const phaseBeforeTurn = chatPhase(record.messages, record.kind);
	const modelId = `${engine.model.provider}:${engine.model.id}`;

	// THE COMPACTION GATE (owner round 14, 2026-10-05): NOTHING model-facing
	// for this chat interleaves with a running compaction — await the settle
	// kick's summary, compact synchronously if still over threshold. The
	// record re-reads after because compaction appends the marker.
	await ensureCompacted(
		{
			chatStore: stores.chatStore,
			engine,
			modelId,
			kind: phaseBeforeTurn,
			thresholdTokens: effectiveThresholdTokens(
				effective.compaction?.thresholdTokens,
				catalogContextLimits().get(modelId),
			),
			systemPromptTokens: Math.ceil(composeInstructions(record.kind === "practice" ? "practice" : "teacher").length / 4),
		},
		chatId,
	);
	record = (await stores.chatStore.getChat(chatId)) ?? record;

	// The input's native appends (pure; the honest 400 for an answer with no
	// pending question call). Wave C: the idle wake carries EVERY queued
	// marker (steerDelivered filters a re-fire of an already-landed one).
	let appends: LhMessage[];
	try {
		appends =
			input.type === "steers"
				? input.steers.filter((steer) => !steerDelivered(record!.messages, steer.id))
				: inputAppends(record, input);
	} catch (err) {
		if (err instanceof ChatInputError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		throw err;
	}

	// A wake whose every marker already landed delivers NOTHING — no
	// continuation, no model call, no spend (the pump's dedupe races the
	// transcript append, so this is reachable).
	if (input.type === "steers" && appends.length === 0) return settledTurnResponse();

	// THE PARALLEL-QUESTION GATE (owner, 2026-10-03 — the deepseek parallel
	// batch incident): an answer that leaves a SIBLING question pending
	// defers its wake. The dock advances to the next question (the answer
	// write + record-changed carry the view); the LAST answer fires the one
	// reaction turn with every result ADJACENT to its calling assistant
	// message — the provider shape law. Nothing else can generate while a
	// question dangles (job wakes wait, continuation folds refuse, the
	// composer gates), so adjacency holds by construction.
	if (input.type === "answer" && danglingQuestionOf([...record.messages, appends[0]!]) !== null) {
		try {
			const write = await answerWrite(chatId, record, input.toolCallId, input.answer);
			await applyAnswer(chatId, write);
		} catch (err) {
			if (err instanceof ChatInputError) {
				return Response.json({ error: err.message }, { status: 400 });
			}
			throw err;
		}
		emit("record-changed", { chatId });
		return settledTurnResponse(); // the cheap terminal — no run
	}

	// One turn per chat, ever (this process). A second request while a turn
	// runs means a stale/remounted client raced a live one; the submit below
	// is the durable half of the same law (ConversationBusy → 409).
	if (!beginTurn(chatId)) {
		console.info(`[chat ${chatId}] turn already in flight — request rejected`);
		return Response.json({ error: "A turn is already running for this session" }, { status: 409 });
	}

	// WRITE-AHEAD: everything the event appends lands before the run starts.
	// The LAST append that can start a run is placed by the input submission
	// itself (it is the turn's own entry); an answer is a ContextEdit over
	// the pose placeholder and the hidden continuation starts the reaction.
	let tail: LhMessage | undefined;
	try {
		if (input.type === "answer") {
			const write = await answerWrite(chatId, record, input.toolCallId, input.answer);
			await applyAnswer(chatId, write);
		} else {
			tail = startsInput(appends[appends.length - 1]) ? appends[appends.length - 1] : undefined;
			await appendMessages(chatId, tail ? appends.slice(0, -1) : appends);
		}
		// Dock fix (owner ruling 2026-09-26): persisted markers are visible
		// in the record — flip their jobs now (the wake's steers ride this
		// write-ahead; the delivering turn may run for minutes).
		for (const appended of appends) {
			if (appended.role === "custom") noteSteerVisible(appended as SteerMessage);
		}
	} catch (err) {
		endTurn(chatId);
		console.error(`[chat ${chatId}] write-ahead persist failed:`, err);
		return Response.json({ error: "Failed to start the turn" }, { status: 500 });
	}

	const turnUsageId = crypto.randomUUID();
	const baseEntryCount = (await readEntries(runtime)).length;
	const baseMessages = projectEntries(await readEntries(runtime));
	const deps = conversationDeps(turn);
	let submission: Awaited<ReturnType<ChatRuntime["root"]["submit"]>>;
	try {
		await prepareConversation(runtime, chatId, baseMessages, record.kind, engine, effective, deps, turn?.tools);
		// Debug recorder run marker (owner, 2026-10-04): correlates the
		// JSONL event stream with the record's turns; no-op unless
		// LH_PROVIDER_EVENTS=1.
		providerEventNote(chatId, "turn", `run start (base: ${baseMessages.length} messages)`);
		const draft = tail ? submissionOf(tail) : undefined;
		submission = await runtime.root.submit(
			draft
				? {
						type: "input",
						content: draft.content as never,
						whenBusy: "reject",
						entry: draft.entry as never,
					}
				: {
						type: "input",
						content: CONTINUATION_TEXT as never,
						whenBusy: "reject",
						entry: { kind: CONTINUATION_KIND } as never,
					},
			BACKGROUND_CONTEXT,
		);
	} catch (err) {
		endTurn(chatId);
		if (err instanceof ConversationBusy) {
			return Response.json({ error: "A turn is already running for this session" }, { status: 409 });
		}
		console.error(`[chat ${chatId}] turn failed to start:`, err);
		return Response.json({ error: "Failed to start the turn" }, { status: 500 });
	}

	const handle = runDurableTurn({
		runtime,
		chatId,
		submission,
		onError: (error) => {
			console.error(`[chat ${chatId}] turn error:`, error);
			return "An error occurred.";
		},
		onEntry: (entry) => {
			const message = (entry.data as { message?: LhMessage } | undefined)?.message;
			if (message?.role !== "custom") return;
			noteSteerVisible(message as SteerMessage);
			markSteerDelivered(chatId, message.id);
		},
		onFinish: async () => {
			// The record is durable throughout the run; these are the settle
			// services the old onFinish owned.
			await appendRunUsage(stores.chatStore, chatId, baseEntryCount, turnUsageId, modelId);
			const after = projectEntries(await readEntries(runtime));
			settleSteers(chatId, after);
			await appendPlanBlocks(stores.chatStore, chatId, baseMessages, after);
			// GRAPH GATE: the write channel dies with the master switch;
			// practice sessions write nothing (v1: the session is the
			// deliverable).
			if (record!.kind !== "practice" && extractionEnabled(effective.graph)) {
				await triggerExtraction(stores, extraction, chatId, effective.graph.extractionChunkTokens);
			}
			// PARKED DISMISSAL (owner, 2026-10-04): a dismissal that arrived
			// mid-turn was parked by the dismiss route; apply it against the
			// settled record now.
			await applyParkedDismissal(chatId);
			// LAST: a reader that sees not-in-flight must read the completed
			// record — endTurn only after the settle services ran.
			endTurn(chatId);
			unregisterTurn(chatId);
			noteTurnSettled(chatId);
			// Any marker still queued (a steer stranded behind the question
			// stop or the abort) goes back through the pump's gates.
			repumpSteers(chatId);
			// THE SETTLE KICK (owner round 14): if the projection is now over
			// threshold, the summary starts in the background INSIDE the
			// learner's reading/answering pause.
			if (process.env.NODE_ENV !== "test")
				kickCompaction(async () => {
					syncCustomEndpointProvider();
					const fresh = effectiveSettings();
					const current = await stores.chatStore.getChat(chatId);
					const spec = resolveConversationSpec(current?.settings, fresh.models.strong);
					if (!spec) return null;
					let kickEngine: PiEngine;
					try {
						kickEngine = piEngineForSpec(spec);
					} catch {
						return null;
					}
					const kickModelId = `${kickEngine.model.provider}:${kickEngine.model.id}`;
					const freshRecord = await stores.chatStore.getChat(chatId);
					if (!freshRecord) return null;
					return {
						chatStore: stores.chatStore,
						engine: kickEngine,
						modelId: kickModelId,
						kind: chatPhase(freshRecord.messages, freshRecord.kind),
						thresholdTokens: effectiveThresholdTokens(
							fresh.compaction?.thresholdTokens,
							catalogContextLimits().get(kickModelId),
						),
						systemPromptTokens: Math.ceil(
							composeInstructions(freshRecord.kind === "practice" ? "practice" : "teacher").length / 4,
						),
					};
				}, chatId);
		},
	});
	// The turn is now a live background object: register it so any view can
	// reattach (GET /api/chats/[id]/stream) or remotely abort it
	// (POST /api/activity/abort, kind "turn").
	registerTurn(chatId, handle);
	noteTurnStarted(chatId);
	// A submission that faults after admission must never go unobserved: the
	// view's wait settles on the same scope, but the error is logged here.
	void submission.wait(BACKGROUND_CONTEXT).catch((error) => {
		console.error(`[chat ${chatId}] submission failed:`, error);
	});
	// CONNECTION DIET B (owner, 2026-10-10): the POST acknowledges acceptance
	// and closes; the turn runs server-side and every view attaches through
	// GET /api/chats/[id]/stream.
	return Response.json({ ok: true });
}
