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

import { tokensForChars } from "../platform/model/index.ts";
import { firstLineById } from "../graph/model/index.ts";
import { processState } from "../platform/model/index.ts";
import { ConversationBusy, LiveDoc, type EntryRecord } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PiEngine } from "../platform/index.ts";
import type { ModelRole } from "../settings/model/index.ts";
import {
	deliverJobResult,
	markSteerDelivered,
	noteSteerVisible,
	repumpSteers,
	settleSteers,
} from "../jobs/index.ts";
import { providerEventNote } from "../platform/index.ts";
import { effectiveSettings, stores } from "../stores.ts";
import { services } from "../boot.ts";
import { searchAvailable, searchProvider } from "../tools/index.ts";
import { providerKeyPresent } from "../settings/index.ts";
import { CUSTOM_ENDPOINT_PROVIDER_ID } from "../settings/model/index.ts";
import {
	resolveConversationSpec,
	resolveRoleSpec,
} from "../settings/model/index.ts";
import { modelsNotConfigured, providerKeyMissing as providerKeyMissingEnvelope } from "../settings/model/index.ts";
import { beginTurn, endTurn, noteTurnSettled, noteTurnStarted } from "./turn-liveness.ts";
import { withChatOperation } from "./chat-operations.ts";
import { applyParkedDismissal } from "./dismissal-park.ts";
import { registerTurn, settledTurnResponse, unregisterTurn } from "./turn-runs.ts";
import {
	appendPlanBlocks,
	appendRunUsage,
	answerWrite,
	applyAnswer,
	claimTurnSettle,
	markTurnSettled,
	readTurn,
	triggerExtraction,
	writeTurn,
	type ForegroundTurn,
	type TurnModel,
} from "./turn-service.ts";
import { danglingQuestionOf } from "./model/transcript.ts";
import { composeInstructions } from "./agents.ts";
import { ensureCompacted, kickCompaction, effectiveThresholdTokens } from "./compaction.ts";
import { catalogContextLimits } from "../settings/index.ts";
import { customEndpointKeyPresent, customEndpointState, engineForSpec } from "../settings/index.ts";
import { emit } from "../platform/model/index.ts";
import {
	ChatInputError,
	inputAppends,
	parseChatInput,
	type TurnInput,
} from "./model/input-events.ts";
import { steerDelivered } from "../jobs/model/index.ts";
import type { SteerMessage } from "../jobs/model/index.ts";
import { modelTextOf, type LhMessage } from "./model/transcript.ts";
import {
	CONTINUATION_KIND,
	CONTINUATION_TEXT,
	appendMessages,
	openChatRuntime,
	projectEntries,
	readEntries,
	ChatRuntimeInitError,
	type ChatRuntime,
} from "./durable.ts";
import { prepareConversation, type ConversationDeps } from "./durable-registry.ts";
import { chatPhase } from "./model/phases.ts";
import { runDurableTurn } from "./pi/durable-turn.ts";
import type { RunDescriptor } from "../jobs/index.ts";

export function providerHasKey(provider: string): boolean {
	return provider === CUSTOM_ENDPOINT_PROVIDER_ID ? customEndpointKeyPresent() : providerKeyPresent(provider);
}

/** The settings-resolved engine for one role — BYOK (owner, 2026-09-22):
 *  the chain (role override → slot → NOTHING) may end empty, and undefined
 *  flows through to the per-need refusal gates (runner/extraction), read
 *  FRESH so a settings PUT between dispatch and spawn lands. */
export function resolveEngine(role: ModelRole): PiEngine | undefined {
	const spec = resolveRoleSpec(role, stores.settingsStore.readSettings());
	if (!spec) return undefined;
	try {
		return engineForSpec(spec);
	} catch (error) {
		console.info(`[models] no engine for role ${role}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}



/** Rebuild a recovered run's engine from its SAFE snapshot. A custom
 *  endpoint edited to another base URL must not silently take over a run
 *  that captured the old one; no credential is ever stored in the snapshot. */
export function engineForModel(model: TurnModel): PiEngine | undefined {
	if (model.provider === CUSTOM_ENDPOINT_PROVIDER_ID) {
		const endpoint = customEndpointState().endpoint;
		if (!endpoint || (model.baseUrl && endpoint.baseUrl !== model.baseUrl)) return undefined;
	}
	try {
		return engineForSpec({
			provider: model.provider,
			id: model.modelId,
			thinkingLevel: model.thinking as never,
		});
	} catch (error) {
		console.info(`[models] cannot restore ${model.provider}:${model.modelId}:`, error);
		return undefined;
	}
}

/** A committed app marker is its steer's visibility moment (the delivery
 *  bookkeeping seam shared by the live turn and a recovered one). */
function noteTurnEntry(chatId: string, entry: EntryRecord): void {
	const message = (entry.data as { message?: LhMessage } | undefined)?.message;
	if (message?.role !== "custom") return;
	noteSteerVisible(message as SteerMessage);
	markSteerDelivered(chatId, message.id);
}

/** Rebuild and reattach a foreground turn that outlived its process. The
 *  extension (tools, prompt, model/engine) must exist BEFORE the scheduler
 *  resumes the interrupted generation, and the recovered view owns the same
 *  finish path as a live turn. Runs from the runtime bootstrap, before
 *  `harness.resume()`, and THROWS when the run cannot be rebuilt: the open
 *  fails closed rather than schedule an uninitialized run. */
export async function resumeForegroundTurn(runtime: ChatRuntime, engineFor: (model: TurnModel) => PiEngine | undefined): Promise<void> {
	const turn = await readTurn(runtime);
	if (!turn || turn.settle === "settled") return;
	// The committed submission is the admission proof: a descriptor written
	// just before a failed submit settles nothing.
	const admitted = await runtime.storage.submissionByRequest(
		runtime.root.id,
		turn.requestId,
		BACKGROUND_CONTEXT,
	);
	if (!admitted) return;
	const live = await runtime.harness.snapshot(LiveDoc, runtime.root.id, BACKGROUND_CONTEXT);
	const entries = await readEntries(runtime);
	// The view boundary is an entry id, not a count: compaction's head marker
	// makes the active view a suffix of the full history readEntries returns.
	const replayAfter = turn.baseEntryCount > 0 ? entries[turn.baseEntryCount - 1]?.id : undefined;
	// A queued submission has not reached the transcript yet: the scheduler's
	// boundary runs it after resume, so its extension must be installed too.
	if (live?.run || admitted.status === "queued") {
		// Fail closed: a run that has not executed must never resume without
		// its model binding.
		const engine = engineFor(turn.model);
		if (!engine) {
			throw new Error(
				`the interrupted turn's model is unavailable (${turn.model.provider}:${turn.model.modelId})`,
			);
		}
		await prepareConversation(
			runtime,
			runtime.chatId,
			projectEntries(entries),
			undefined,
			engine,
			effectiveSettings(),
			conversationDeps(),
			{ phase: turn.phase },
		);
		providerEventNote(runtime.chatId, "turn", `run resumed (base: ${turn.baseEntryCount} entries)`);
	}
	// A run that FINISHED before its process died is recovered the same way:
	// its settled submission resolves at once and the handle applies the
	// settle services without starting anything.
	const submission = await runtime.harness.submission(admitted.id, BACKGROUND_CONTEXT);
	const ownsClaim = beginTurn(runtime.chatId);
	let handedOff = false;
	try {
		registerTurn(
			runtime.chatId,
			runDurableTurn({
				runtime,
				chatId: runtime.chatId,
				submission,
				replayAfter,
				onError: (error) => {
					console.error(`[chat ${runtime.chatId}] recovered turn error:`, error);
					return "An error occurred.";
				},
				onEntry: (entry) => noteTurnEntry(runtime.chatId, entry),
				onFinish: () => settleForegroundTurn(runtime, runtime.chatId, turn),
			}),
		);
		handedOff = true;
		noteTurnStarted(runtime.chatId);
	} finally {
		if (ownsClaim && !handedOff) endTurn(runtime.chatId);
	}
}

/** One settle per turn in this process: a live handle racing a recovery joins
 *  the first finisher instead of applying the services twice. The durable
 *  mark covers the process that died mid-settle. */
function turnSettles(): Map<string, Promise<void>> {
	return processState("turnSettles", () => new Map<string, Promise<void>>());
}

/** THE finish path for one admitted turn, shared by its live handle and a
 *  recovered one: usage, steer reconciliation, plan blocks, extraction, the
 *  parked dismissal, the durable settle mark, then the lifecycle release. */
function settleForegroundTurn(runtime: ChatRuntime, chatId: string, turn: ForegroundTurn): Promise<void> {
	const key = `${chatId}:${turn.turnId}`;
	const running = turnSettles().get(key);
	if (running) return running;
	const settle = settleTurnOnce(runtime, chatId, turn).finally(() => {
		if (turnSettles().get(key) === settle) turnSettles().delete(key);
	});
	turnSettles().set(key, settle);
	return settle;
}

async function settleTurnOnce(runtime: ChatRuntime, chatId: string, turn: ForegroundTurn): Promise<void> {
	let claimed = false;
	try {
		claimed = await claimTurnSettle(runtime, turn.turnId);
	} catch (error) {
		// A COMMIT error is not a false claim: the durable mark may still say
		// running, so run the idempotent services and release the in-process
		// claim now instead of wedging the chat until the 30-minute TTL.
		console.error(`[chat ${chatId}] turn settle claim failed:`, error);
		claimed = true;
	}
	if (!claimed) return;
	try {
		await appendRunUsage(stores.chatStore, chatId, turn.baseEntryCount, turn.turnId, turn.modelId);
		const entries = await readEntries(runtime);
		const after = projectEntries(entries);
		const before = projectEntries(entries.slice(0, turn.baseEntryCount));
		settleSteers(chatId, after);
		await appendPlanBlocks(stores.chatStore, chatId, before, after);
		const effective = effectiveSettings();
		const record = await stores.chatStore.getChat(chatId);
		// GRAPH GATE: the write channel dies with the master switch; practice
		// sessions write nothing (v1: the session is the deliverable).
		if (services().upkeep && record !== null && record.kind !== "practice" && effective.graph.enabled) {
			await triggerExtraction(stores, services().extraction, chatId, effective.graph.extractionChunkTokens);
		}
		// PARKED DISMISSAL: a dismissal that arrived
		// mid-turn was parked by the dismiss route; apply it against the
		// settled record now.
		if (await applyParkedDismissal(chatId)) await stores.chatStore.touchChat(chatId);
		await markTurnSettled(runtime, turn.turnId);
	} catch (error) {
		// The mark stays "settling": the next open re-runs these idempotent
		// services instead of losing them.
		console.error(`[chat ${chatId}] turn settle failed:`, error);
	}
	// LAST: a reader that sees not-in-flight must read the settled record —
	// the handle leaves only after the services ran.
	endTurn(chatId);
	unregisterTurn(chatId);
	noteTurnSettled(chatId);
	// Any marker still queued (a steer stranded behind the question stop or
	// the abort) goes back through the pump's gates.
	repumpSteers(chatId);
	// THE SETTLE KICK: if the projection is now over
	// threshold, the summary starts in the background INSIDE the learner's
	// reading/answering pause.
	if (services().upkeep)
		kickCompaction(async () => {
			const fresh = effectiveSettings();
			const current = await stores.chatStore.getChat(chatId);
			const spec = resolveConversationSpec(current?.settings, fresh.models.strong);
			if (!spec) return null;
			let kickEngine: PiEngine;
			try {
				kickEngine = engineForSpec(spec);
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
					tokensForChars(composeInstructions(freshRecord.kind === "practice" ? "practice" : "teacher").length),
				),
			};
		}, chatId);
}


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
		spawn: (job, jobInput) => void services().jobRunner.runJob(job.id, jobInput),
		deliver: (steer) => void deliverJobResult(steer as SteerMessage),
		searchAvailable,
		graphNodes: () => firstLineById(stores.graphStore.readNodes()).map((node) => ({ id: node.id, name: node.name })),
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
	return withChatOperation(chatId, async () => {
		let record: Awaited<ReturnType<typeof stores.chatStore.getChat>>;
		try {
			record = await stores.chatStore.getChat(chatId);
		} catch (error) {
			// Fail-closed runtime open (a previous run could not be restored): the
			// committed inputs are untouched, so the retry is just another POST.
			if (error instanceof ChatRuntimeInitError) {
				console.error(`[chat ${chatId}] turn refused — ${error.message}`, error.cause);
				return Response.json({ error: error.message, code: "runtime_unavailable" }, { status: 503 });
			}
			throw error;
		}
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
		let engine: PiEngine;
		try {
			engine = turn?.engine ?? engineForSpec(conversation);
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

		// THE COMPACTION GATE: NOTHING model-facing
		// for this chat interleaves with a running compaction — await the settle
		// kick's summary, compact synchronously if still over threshold. The
		// record re-reads after because compaction appends the marker.
		if (services().upkeep) await ensureCompacted(
			{
				chatStore: stores.chatStore,
				engine,
				modelId,
				kind: phaseBeforeTurn,
				thresholdTokens: effectiveThresholdTokens(
					effective.compaction?.thresholdTokens,
					catalogContextLimits().get(modelId),
				),
				systemPromptTokens: tokensForChars(composeInstructions(record.kind === "practice" ? "practice" : "teacher").length),
			},
			chatId,
		);
		record = (await stores.chatStore.getChat(chatId)) ?? record;

		// The input's native appends (pure; the honest 400 for an answer with no
		// pending question call). The idle wake carries EVERY queued
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

		// THE QUESTION-PAUSE GENERATION GATE: while any question is unanswered,
		// an explicit continue or a wake carrying late results may not start a
		// generation (the phantom mount continuation after a pose). The answer
		// path below is the only way through; it replaces the placeholder before
		// any run. A steer wake gets 409 so the pump retries, never a fake
		// delivery.
		if ((input.type === "continue" || input.type === "steers") && danglingQuestionOf(record.messages) !== null) {
			if (input.type === "steers") {
				return Response.json({ error: "A question is pending" }, { status: 409 });
			}
			return settledTurnResponse();
		}

		// THE PARALLEL-QUESTION GATE: an answer that leaves a SIBLING question pending
		// defers its wake. The dock advances to the next question (the answer
		// write + record-changed carry the view); the LAST answer fires the one
		// reaction turn with every result ADJACENT to its calling assistant
		// message — the provider shape law. The gate above is the server's one
		// generation boundary; this branch is the answer's cheap terminal.
		if (input.type === "answer" && danglingQuestionOf([...record.messages, appends[0]!]) !== null) {
			try {
				const write = await answerWrite(chatId, record, input.toolCallId, input.answer);
				await applyAnswer(chatId, write);
				await stores.chatStore.touchChat(chatId).catch((err) => {
					console.error(`[chat ${chatId}] activity touch failed:`, err);
				});
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
		let handedOff = false;
		try {
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
				console.error(`[chat ${chatId}] write-ahead persist failed:`, err);
				return Response.json({ error: "Failed to start the turn" }, { status: 500 });
			}
			await stores.chatStore.touchChat(chatId).catch((err) => {
				console.error(`[chat ${chatId}] activity touch failed:`, err);
			});

			const turnUsageId = crypto.randomUUID();
			const admittedEntries = await readEntries(runtime);
			const baseEntryCount = admittedEntries.length;
			const baseMessages = projectEntries(admittedEntries);
			// The live view starts at the admission boundary, exactly like recovery:
			// replaying the whole chat would resend every earlier reply and tool round.
			const replayAfter = baseEntryCount > 0 ? admittedEntries[baseEntryCount - 1]!.id : undefined;
			const phase = chatPhase(baseMessages, record.kind);
			// The durable admission descriptor: everything a later process needs to
			// rebuild this turn's finish path (see turn-service's ForegroundTurn).
			// Written BEFORE submit; only a committed submission makes it recoverable.
			const admission: ForegroundTurn = {
				turnId: turnUsageId,
				requestId: `turn:${turnUsageId}`,
				modelId,
				model: {
					provider: engine.model.provider,
					modelId: engine.model.id,
					...(engine.level ? { thinking: engine.level } : {}),
					...(engine.model.baseUrl ? { baseUrl: engine.model.baseUrl } : {}),
				},
				phase,
				baseEntryCount,
				settle: "running",
			};
			const deps = conversationDeps(turn);
			let submission: Awaited<ReturnType<ChatRuntime["root"]["submit"]>>;
			try {
				await writeTurn(runtime, admission);
				await prepareConversation(runtime, chatId, baseMessages, record.kind, engine, effective, deps, {
					tools: turn?.tools,
					phase,
				});
				// Debug recorder run marker: correlates the
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
								requestId: admission.requestId,
								entry: draft.entry as never,
							}
						: {
								type: "input",
								content: CONTINUATION_TEXT,
								whenBusy: "reject",
								requestId: admission.requestId,
								entry: { kind: CONTINUATION_KIND } as never,
							},
					BACKGROUND_CONTEXT,
				);
			} catch (err) {
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
				replayAfter,
				onError: (error) => {
					console.error(`[chat ${chatId}] turn error:`, error);
					return "An error occurred.";
				},
				onEntry: (entry) => noteTurnEntry(chatId, entry),
				onFinish: () => settleForegroundTurn(runtime, chatId, admission),
			});
			// The turn is now a live background object: register it so any view can
			// reattach (GET /api/chats/[id]/stream) or remotely abort it
			// (POST /api/activity/abort, kind "turn").
			registerTurn(chatId, handle);
			handedOff = true;
			noteTurnStarted(chatId);
			// A submission that faults after admission must never go unobserved: the
			// view's wait settles on the same scope, but the error is logged here.
			void submission.wait(BACKGROUND_CONTEXT).catch((error) => {
				console.error(`[chat ${chatId}] submission failed:`, error);
			});
			// CONNECTION DIET B: the POST acknowledges acceptance
			// and closes; the turn runs server-side and every view attaches through
			// GET /api/chats/[id]/stream.
			return Response.json({ ok: true });
		} finally {
			if (!handedOff) endTurn(chatId);
		}
	});
}
