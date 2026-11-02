// Packaged launches skip dotenv; only source-run servers read local env files.
import path from "node:path";
import { buildPayload } from "./build-server.mjs";
import { loadProcessEnv } from "./load-env.mjs";

loadProcessEnv("production");
const root = path.resolve(import.meta.dirname, "..");
process.env.LH_DATA_DIR ||= path.join(root, "data");
process.env.LH_AUTH_FILE ||= path.join(root, "auth.json");
buildPayload();
await import("../dist-server/standalone/server.js");
