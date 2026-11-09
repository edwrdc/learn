/** Boot the app's services (job runner, extraction, wake and recovery wiring)
 *  the way the server's init hook does, without upkeep. Tests put scripted
 *  engines in `testEngines` by role; a recovered foreground turn reads
 *  "teacher". Import after ./support-tmp-data.ts. */
import type { PiEngine } from "../src/platform/index.ts";
import type { ModelRole } from "../src/settings/model/index.ts";
import { boot } from "../src/boot.ts";

export const testEngines: Partial<Record<ModelRole, PiEngine>> = {};

boot({ upkeep: false, engineFor: (role) => testEngines[role] });
