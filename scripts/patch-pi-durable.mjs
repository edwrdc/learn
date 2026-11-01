// pi-durable@1.4.0 has no supported afterTools stop, input park, or hook entry read; patch the exact installed dist.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const NAME = "@earendil-works/pi-durable";
const VERSION = "1.4.0";
const root = process.argv[2] ?? dirname(createRequire(import.meta.url).resolve(`${NAME}/package.json`));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.equal(manifest.name, NAME, `expected ${NAME} at ${root}, found ${manifest.name}`);
assert.equal(manifest.version, VERSION, `the question-stop patch targets ${NAME}@${VERSION}, found ${manifest.version}`);

const runtime = join(root, "dist/harness/generation.js");
const types = join(root, "dist/harness/types.d.ts");

const patches = [
	{
		file: runtime,
		before: `    await runtime.hooks.each("afterTools", (hook) => hook(assistant, results, runtime, context));
    // Every call of the round, including those answered without a task, must ask to terminate.
    const terminate = slots.length > 0 &&
        slots.every((slot) => slot.taskId !== undefined && controls.get(slot.taskId)?.terminate === true);`,
		after: `    let extensionTerminate = false;
    let extensionPark = false;
    await runtime.hooks.each("afterTools", async (hook) => {
        const result = await hook(assistant, results, runtime, context);
        if (result?.terminate === true)
            extensionTerminate = true;
        if (result?.parkInputs === true)
            extensionPark = true;
    });
    // Every call of the round, including those answered without a task, must ask to terminate.
    const terminate = extensionTerminate ||
        (slots.length > 0 &&
            slots.every((slot) => slot.taskId !== undefined && controls.get(slot.taskId)?.terminate === true));`,
	},
	{
		file: types,
		before: `    /** After every tool of the round is terminal; \`results\` are the round's result entries in call order. */
    afterTools(assistant: EntryId, results: readonly EntryId[], api: HookApi, context: Context): void | Promise<void>;`,
		after: `    /** After every tool of the round is terminal; \`results\` are the round's result entries in call order. Return \`{ terminate: true }\` to end the run as a native terminate does. */
    afterTools(assistant: EntryId, results: readonly EntryId[], api: HookApi, context: Context): HookResult<{
        readonly terminate: true;
        /** With \`terminate\`: leave queued inputs in the inbox for the next run's boundary instead of placing them now. */
        readonly parkInputs?: true;
    } | void>;`,
	},
	{
		file: runtime,
		before: `import { applyBoundary, prepareBoundary, withdrawQueuedInputs } from "./inbox.js";`,
		after: `import { applyBoundary, hasQueuedReset, prepareBoundary, withdrawQueuedInputs } from "./inbox.js";`,
	},
	{
		file: runtime,
		before: `        const now = runtime.now();
        if (terminate || handoff !== undefined) {
            if (handoff !== undefined) {`,
		after: `        const now = runtime.now();
        if (terminate || handoff !== undefined) {
            // An extension park ends the run with the inbox untouched; a handoff or queued reset keeps native placement.
            if (extensionPark && handoff === undefined && !hasQueuedReset(boundary.inbox.items)) {
                endRun(tx, live, runtime.taskId, { status: "done", answer: assistant });
                return { status: "terminal", outcome: { status: "completed", result: { entryId: assistant } } };
            }
            if (handoff !== undefined) {`,
	},
	{
		file: types,
		before: `    memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
}
export type HookResult<T> = T | undefined | Promise<T | undefined>;`,
		after: `    memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
    /** Committed entry visible from the asking task's conversation. */
    entry(id: EntryId, context: Context): Promise<EntryRecord | undefined>;
}
export type HookResult<T> = T | undefined | Promise<T | undefined>;`,
	},
];

const pending = new Map();
for (const patch of patches) {
	const text = pending.get(patch.file) ?? readFileSync(patch.file, "utf8");
	if (text.includes(patch.after)) continue;
	assert.ok(text.includes(patch.before), `${patch.file} is not the expected ${NAME}@${VERSION} source; refusing to patch`);
	pending.set(patch.file, text.replace(patch.before, patch.after));
}
for (const [file, text] of pending) writeFileSync(file, text);
console.log(`${NAME}@${VERSION}: ${pending.size === 0 ? "already patched" : `patched ${pending.size} file(s)`}`);
