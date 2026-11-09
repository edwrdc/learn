/** Boot the app's services (job runner, extraction, wake and recovery wiring)
 *  the way the server's init hook does. Import after ./support-tmp-data.ts. */
import { boot } from "../src/boot.ts";

boot();
