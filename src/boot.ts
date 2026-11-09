import { processState } from "./platform/model/index.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { configureBackgroundRuns, createJobRunner, recoverStaleJobs, resumeBackgroundRuns, retireBackgroundRun, runBackgroundConversation, setBackgroundRetire, setBackgroundRun, setJobRespawn, setTurnRunner, deliverJobResult, type JobRunner } from "./jobs/index.ts";
import { createExtractionPipeline, type ExtractionPipeline } from "./graph/index.ts";
import { searchProvider } from "./tools/index.ts";
import { providerKeyMissing, type ModelRole, type ModelSlotName } from "./settings/model/index.ts";
import type { PiEngine } from "./platform/index.ts";
import { initAuthEnv } from "./settings/index.ts";
import { openChatRuntime, setRuntimeBootstrap } from "./session/durable.ts";
import { engineForModel, handleChatInput, providerHasKey, resolveEngine, resumeForegroundTurn } from "./session/turn.ts";

export interface BootOptions {
	/** Background upkeep: crash recovery at boot, the extraction trigger and
	 *  compaction after turns. Tests turn it off: their chats are fixtures. */
	upkeep?: boolean;
	/** Replaces the settings-resolved engine for a role (scripted test
	 *  engines). A recovered foreground turn asks for "teacher". */
	engineFor?: (role: ModelRole) => PiEngine | undefined;
}

export interface AppServices {
	jobRunner: JobRunner;
	extraction: ExtractionPipeline;
	upkeep: boolean;
	/** Settles when boot recovery has finished (at once without upkeep). */
	recovered: Promise<void>;
}

const keyGate = (provider: string, tier: ModelSlotName) => providerHasKey(provider) ? null : providerKeyMissing(provider, [tier]);

/** Open every chat's runtime once, so runs a process death interrupted
 *  resume, then re-deliver or re-run orphaned jobs. Reads never recover. */
async function recover(): Promise<void> {
	for (const chat of await stores.chatStore.listChats()) {
		await openChatRuntime(chat.id).catch((error) => console.error(`[boot] ${chat.id} did not reopen:`, error));
	}
	await recoverStaleJobs();
}

export function boot(options: BootOptions = {}): AppServices {
	const services = processState("services", () => {
		initAuthEnv();
		const engineFor = (role: ModelRole) => options.engineFor?.(role) ?? resolveEngine(role);
		const jobRunner = createJobRunner({ chatStore: stores.chatStore, jobStore: stores.jobStore, deliver: deliverJobResult, engineFor, providerKeyMissing: keyGate, searchProvider });
		const extraction = createExtractionPipeline({ ...stores, engineFor, providerKeyMissing: keyGate, getChunkTokens: () => effectiveSettings().graph.extractionChunkTokens });
		setTurnRunner(async (chatId, input) => (await handleChatInput(chatId, input)).status);
		setJobRespawn((jobId) => void jobRunner.runJob(jobId));
		configureBackgroundRuns({ resolveEngine: (descriptor) => engineForModel(descriptor.model), searchProvider });
		setBackgroundRun((request) => runBackgroundConversation(request));
		setBackgroundRetire((chatId, jobId) => retireBackgroundRun(chatId, jobId));
		setRuntimeBootstrap(async (runtime) => {
			await resumeBackgroundRuns(runtime);
			await resumeForegroundTurn(runtime, (model) => options.engineFor?.("teacher") ?? engineForModel(model));
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
