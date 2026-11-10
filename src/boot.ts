import { processState } from "./platform/model/index.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { configureBackgroundRuns, createJobRunner, recoverStaleJobs, resumeBackgroundRuns, retireBackgroundRun, runBackgroundConversation, setBackgroundRetire, setBackgroundRun, setJobRespawn, setTurnRunner, deliverJobResult, type JobRunner } from "./jobs/index.ts";
import { createExtractionPipeline, type ExtractionPipeline } from "./graph/index.ts";
import { resolveRoleSpec, type ModelRole } from "./settings/model/index.ts";
import type { PiEngine } from "./platform/index.ts";
import { engineForSnapshot, engineForSpec, initAuthEnv, missingProviderKey, readSettings, searchProvider } from "./settings/index.ts";
import { openChatRuntime, setRuntimeBootstrap } from "./session/durable.ts";
import { handleChatInput, resumeForegroundTurn } from "./session/turn.ts";

interface BootOptions {
	/** Background upkeep: crash recovery at boot, the extraction trigger and
	 *  compaction after turns. Tests turn it off: their chats are fixtures. */
	upkeep?: boolean;
	/** Replaces the settings-resolved engine for a role (scripted test
	 *  engines). A recovered foreground turn asks for "teacher". */
	engineFor?: (role: ModelRole) => PiEngine | undefined;
}

interface AppServices {
	jobRunner: JobRunner;
	extraction: ExtractionPipeline;
	upkeep: boolean;
	/** Settles when boot recovery has finished (at once without upkeep). */
	recovered: Promise<void>;
}

/** The settings-resolved engine for a role, read fresh so a settings PUT
 *  between dispatch and spawn lands. Undefined (no model configured, or
 *  one the catalog lost) reaches the per-need refusal gates. */
function resolveEngine(role: ModelRole): PiEngine | undefined {
	const spec = resolveRoleSpec(role, readSettings());
	if (!spec) return undefined;
	try {
		return engineForSpec(spec);
	} catch (error) {
		console.info(`[models] no engine for role ${role}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

/** Open every chat's runtime once, so runs a process death interrupted
 *  resume, then re-deliver or re-run orphaned jobs. Reads never recover. */
async function recover(): Promise<void> {
	for (const chat of await stores.chatStore.listChats()) {
		await openChatRuntime(chat.id).catch((error) => console.error(`[boot] ${chat.id} did not reopen:`, error));
	}
	await recoverStaleJobs();
}

export function boot(options: BootOptions = {}): AppServices {
	const first = processState("bootOptions", () => options);
	if ((first.upkeep ?? true) !== (options.upkeep ?? true) || first.engineFor !== options.engineFor) {
		throw new Error("boot() was already called with different options");
	}
	const services = processState("services", () => {
		initAuthEnv();
		const engineFor = (role: ModelRole) => options.engineFor?.(role) ?? resolveEngine(role);
		const jobRunner = createJobRunner({ chatStore: stores.chatStore, jobStore: stores.jobStore, deliver: deliverJobResult, engineFor, providerKeyMissing: missingProviderKey, searchProvider });
		const extraction = createExtractionPipeline({ ...stores, engineFor, providerKeyMissing: missingProviderKey, getChunkTokens: () => effectiveSettings().graph.extractionChunkTokens });
		setTurnRunner(async (chatId, input) => (await handleChatInput(chatId, input)).status);
		setJobRespawn((jobId) => void jobRunner.runJob(jobId));
		configureBackgroundRuns({ resolveEngine: (descriptor) => engineForSnapshot(descriptor.model), searchProvider });
		setBackgroundRun((request) => runBackgroundConversation(request));
		setBackgroundRetire((chatId, jobId) => retireBackgroundRun(chatId, jobId));
		setRuntimeBootstrap(async (runtime) => {
			await resumeBackgroundRuns(runtime);
			await resumeForegroundTurn(runtime, (model) => options.engineFor?.("teacher") ?? engineForSnapshot(model));
		});
		const upkeep = options.upkeep ?? true;
		return { jobRunner, extraction, upkeep, recovered: Promise.resolve() } satisfies AppServices;
	});
	if (services.upkeep) services.recovered = processState("recovery", () => recover().catch((error) => console.error("[boot] recovery failed:", error)));
	return services;
}

export function services(): AppServices {
	return processState<AppServices>("services", () => {
		throw new Error("services() before boot(): call boot() at process start");
	});
}
