import { loadEnv } from "vite";

/**
 * Populate Node's environment for the backend, not just Vite's env modules.
 * @param {string} mode
 * @param {string | false} [envDir]
 */
export function loadProcessEnv(mode, envDir = process.cwd()) {
	for (const [key, value] of Object.entries(loadEnv(mode, envDir, ""))) {
		if (process.env[key] === undefined) process.env[key] = value;
	}
}
