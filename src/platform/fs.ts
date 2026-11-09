import fs from "node:fs";
import path from "node:path";

/** Replace `file` with `data` atomically: write a temp file beside it, then
 *  rename over it, so a crash never leaves a torn file a reader parses as
 *  empty. `mode` is set before the rename (secrets never exist relaxed). */
export function writeFileAtomic(file: string, data: string, options: { mode?: number } = {}): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	try {
		fs.writeFileSync(tmp, data, { encoding: "utf-8", mode: options.mode });
		if (options.mode !== undefined) fs.chmodSync(tmp, options.mode); // the umask may have relaxed the create mode
		fs.renameSync(tmp, file);
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		throw error;
	}
}

/** writeFileAtomic for a pretty-printed JSON value. */
export function writeJsonAtomic(file: string, value: unknown, options: { mode?: number } = {}): void {
	writeFileAtomic(file, JSON.stringify(value, null, "\t"), options);
}
