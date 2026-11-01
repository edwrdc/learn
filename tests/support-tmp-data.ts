/**
 * FIRST import in any test that touches the durable runtime: give the test
 * process a disposable LH_DATA_DIR before src/config.ts is evaluated.
 * Import evaluation order is source order, so listing this module first is
 * what makes the assignment land before the app's PATHS freeze.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-durable-test-"));
process.env.LH_DATA_DIR = dir;
process.on("exit", () => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* already gone */
	}
});
