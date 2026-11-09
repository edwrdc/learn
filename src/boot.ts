import { processState } from "./platform/process.ts";
import { effectiveSettings, stores } from "./stores.ts";
import {
	configureBackgroundRuns,
	createJobRunner,
	resumeBackgroundRuns,
	retireBackgroundRun,
	runBackgroundConversation,
	setBackgroundRetire,
	setBackgroundRun,
	setJobRespawn,
	setTurnRunner,
	deliverJobResult,
	type JobRunner,
} from "./jobs/index.ts";
import { createExtractionPipeline, type ExtractionPipeline } from "./graph/index.ts";
import { searchProvider } from "./tools/index.ts";
import { providerKeyMissing, type ModelSlotName } from "./settings/model/index.ts";
import { setRuntimeBootstrap } from "./session/durable.ts";
import {
	engineForModel,
	handleChatInput,
	providerHasKey,
	resolveEngine,
	resumeForegroundTurn,
} from "./session/turn.ts";

export interface AppServices {
	jobRunner: JobRunner;
	extraction: ExtractionPipeline;
}

const keyGate = (provider: string, tier: ModelSlotName) =>
	providerHasKey(provider) ? null : providerKeyMissing(provider, [tier]);

/** Build the app's services and wire them together. Idempotent: the first
 *  call in a process does the work, later calls return the same services. */
export function boot(): AppServices {
	return processState("services", () => {
		const jobRunner = createJobRunner({
			chatStore: stores.chatStore,
			jobStore: stores.jobStore,
			deliver: deliverJobResult,
			engineFor: (role) => resolveEngine(role),
			providerKeyMissing: keyGate,
			searchProvider,
		});
		const extraction = createExtractionPipeline({
			...stores,
			engineFor: (role) => resolveEngine(role),
			providerKeyMissing: keyGate,
			getChunkTokens: () => effectiveSettings().graph.extractionChunkTokens,
		});
		setTurnRunner(async (chatId, input) => (await handleChatInput(chatId, input)).status);
		setJobRespawn((jobId) => void jobRunner.runJob(jobId));
		configureBackgroundRuns({
			resolveEngine: (descriptor) => engineForModel(descriptor.model),
			searchProvider,
		});
		setBackgroundRun((request) => runBackgroundConversation(request));
		setBackgroundRetire((chatId, jobId) => retireBackgroundRun(chatId, jobId));
		setRuntimeBootstrap(async (runtime) => {
			await resumeBackgroundRuns(runtime);
			await resumeForegroundTurn(runtime);
		});
		return { jobRunner, extraction };
	});
}

/** The booted services. Throws when nothing called boot() in this process. */
export function services(): AppServices {
	return processState<AppServices>("services", () => {
		throw new Error("services() before boot(): call boot() at process start");
	});
}
