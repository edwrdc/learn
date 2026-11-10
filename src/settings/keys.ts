/**
 * The server-side key manager behind GET/PUT/DELETE /api/keys.
 *
 * The env seam: consumers (pi-ai, web tools, dictation) read process.env
 * directly, so the store reflects itself into the env — at boot every file
 * var unset in the real env is fill-gapped into process.env, and each
 * save/delete updates file + env together. Keys take effect with no
 * restart. (So the desktop shell must not inject keys into the env at
 * spawn: that copy would shadow every settings-page change.)
 *
 * Precedence (owner decision): real environment variables (incl.
 * .env.local in dev) always win over the file. Boot-time real-env vars are
 * snapshotted once per process; a PUT to one of them persists to the file
 * and the status reports shadowedByEnv.
 *
 * Unknown vars in the file are preserved and surfaced as generic status rows.
 *
 * The fresh-user switch (owner decision): LH_IGNORE_ENV_KEYS=1 makes every
 * env key invisible app-wide, simulating a new user. Real env vars are
 * deleted from the process, not merely ignored: pi-ai resolves provider
 * keys from live process.env at every request, so deletion is the one
 * mechanism that hides them from every consumer. Only auth.json counts; the
 * fill-gap still reflects file keys so keys added mid-session work.
 */

import { processState } from "../platform/model/index.ts";
import {
	AUTH_KEYS,
	AUTH_PROVIDER_KEYS,
	AUTH_PROVIDER_ENV_VARS,
	type AuthKeyStatus,
	genericProviderKeyGuard,
	isKnownAuthKey,
	isProviderEnvVar,
	maskKey,
	validateKeyShape,
} from "./model/auth-keys.ts";
import { authStore } from "./auth-store.ts";
import {
	CUSTOM_ENDPOINT_KEY_ID,
	isCustomEndpointKeyId,
} from "./model/custom-endpoint.ts";

// Process-wide: an HMR re-import must not re-run the snapshot and misread
// fill-gapped vars as real env.
interface AuthBoot {
	/** Vars that were in the real env at first init — never overwritten. */
	realEnv: Set<string>;
	/** Vars we put into process.env (the file's reflection) — deletable. */
	fillGap: Set<string>;
}
function boot(): AuthBoot {
	return processState<AuthBoot>("authBoot", () => ({ realEnv: new Set(), fillGap: new Set() }));
}

/** A curated catalog key or a model-provider env var. */
export function isWritableAuthKey(id: string): boolean {
	return isKnownAuthKey(id) || isProviderEnvVar(id);
}

/** The settings page's provider dropdown: every pi-ai provider that takes
 *  a plain key, sorted by id. */
export function providerKeyList() {
	return [...AUTH_PROVIDER_KEYS].sort((a, b) => a.id.localeCompare(b.id));
}

/** The fresh-user switch. Read live per call (the launcher exports it
 *  before boot). */
export function envKeysIgnored(): boolean {
	return process.env.LH_IGNORE_ENV_KEYS === "1";
}

/**
 * The boot fill-gap — idempotent. The first call snapshots which managed
 * names are real env; later calls only fill vars still unset in the env.
 */
export function initAuthEnv(): void {
	const record = boot();
	const fileVars = authStore.authVars();
	const managed = new Set<string>([
		...Object.keys(fileVars),
		...AUTH_KEYS.map((k) => k.id),
		...AUTH_PROVIDER_KEYS.map((p) => p.envVar),
		CUSTOM_ENDPOINT_KEY_ID,
	]);
	if (envKeysIgnored()) {
		for (const name of managed) {
			delete process.env[name];
		}
	} else if (record.realEnv.size === 0 && record.fillGap.size === 0) {
		for (const name of managed) {
			if (process.env[name] !== undefined) record.realEnv.add(name);
		}
	}
	for (const [name, value] of Object.entries(fileVars)) {
		if (!isManagedName(name)) continue;
		if (process.env[name] === undefined) {
			process.env[name] = value;
			record.fillGap.add(name);
		}
	}
}

function isManagedName(name: string): boolean {
	return isWritableAuthKey(name) || name in authStore.authVars();
}

/** The pure status projection. `env` is the live process env; `realEnv`
 *  the boot snapshot. */
function resolveKeyStatuses(
	fileVars: Record<string, string>,
	env: Record<string, string | undefined>,
	realEnv: ReadonlySet<string>,
	/** Model-provider env vars get a row only when present; curated keys
	 *  always get one. */
	providerEnvVars: ReadonlySet<string> = new Set(),
): AuthKeyStatus[] {
	const ids = new Set<string>([...AUTH_KEYS.map((k) => k.id), ...Object.keys(fileVars)]);
	for (const id of ids) {
		if (isCustomEndpointKeyId(id)) ids.delete(id);
	}
	for (const envVar of providerEnvVars) {
		if (env[envVar] !== undefined || fileVars[envVar] !== undefined) ids.add(envVar);
	}
	const rows: AuthKeyStatus[] = [];
	for (const id of ids) {
		const envValue = env[id];
		const fileValue = fileVars[id];
		const isRealEnv = realEnv.has(id);
		// After the fill-gap the file's values live in env too; realEnv is what
		// tells a real env var from the store's reflection.
		const live = envValue !== undefined ? envValue : fileValue;
		rows.push({
			id,
			info: AUTH_KEYS.find((k) => k.id === id) ?? null,
			present: live !== undefined,
			masked: live !== undefined ? `${maskKey(live)} (${live.trim().length} chars)` : null,
			source: isRealEnv ? "env" : live !== undefined ? "file" : "none",
			shadowedByEnv: isRealEnv && fileValue !== undefined && envValue !== fileValue,
		});
	}
	return rows;
}

/** The GET view: every curated key (present or not) + unknown file vars. */
export function keyStatuses(): AuthKeyStatus[] {
	return resolveKeyStatuses(authStore.authVars(), process.env, boot().realEnv, AUTH_PROVIDER_ENV_VARS);
}

/** The live value for one var, env-first — correct even before the boot
 *  fill-gap ran. */
export function keyValue(id: string): string | undefined {
	// Guards any env key reintroduced after the boot deletion.
	if (envKeysIgnored()) return authStore.authVars()[id];
	return process.env[id] ?? authStore.authVars()[id];
}

/** Is the live value for this id owned by the real environment (not the
 *  store's fill-gap reflection)? The custom endpoint uses it to keep an env
 *  key read-only and origin-bound. */
export function secretFromRealEnv(id: string): boolean {
	if (envKeysIgnored()) return false;
	return boot().realEnv.has(id) && process.env[id] !== undefined;
}

/** Would this builtin provider's key be present at request time? Reads
 * through keyValue, the same env-first lookup pi-ai performs at every
 * request, so an env-shadowed key counts. Providers absent from
 * AUTH_PROVIDER_KEYS take no key at all. */
export function providerKeyPresent(provider: string): boolean {
	const info = AUTH_PROVIDER_KEYS.find((p) => p.id === provider);
	return info ? keyValue(info.envVar) !== undefined : true;
}

/** Persist a secret and reflect it into the env (unless the real env owns
 *  it), without saveKey's shape gate. */
export function saveSecretVar(id: string, value: string): void {
	authStore.setAuthVar(id, value);
	const record = boot();
	if (!record.realEnv.has(id)) {
		process.env[id] = value;
		record.fillGap.add(id);
	}
}

/** Remove a secret: file always, env only when the copy was ours. */
export function deleteSecretVar(id: string): void {
	authStore.deleteAuthVar(id);
	const record = boot();
	if (record.fillGap.has(id) && !record.realEnv.has(id)) {
		delete process.env[id];
		record.fillGap.delete(id);
	}
}

/** Save one key (PUT). Bad pastes are refused, never stored (owner
 *  decision). */
export function saveKey(id: string, value: string): { ok: true; status: AuthKeyStatus } | { ok: false; error: string } {
	const shape = isProviderEnvVar(id) ? genericProviderKeyGuard(id, value) : validateKeyShape(id, value);
	if (!shape.ok) return { ok: false, error: shape.error };
	const trimmed = value.trim();
	saveSecretVar(id, trimmed);
	// validateKeyShape guarantees catalog membership, so the row exists.
	return { ok: true, status: keyStatuses().find((s) => s.id === id)! };
}

/** Remove one key (DELETE); a real env var stays and its row still shows
 *  present. */
export function deleteKey(id: string): AuthKeyStatus {
	deleteSecretVar(id);
	return keyStatuses().find((s) => s.id === id)!;
}

/** A short-lived Deepgram token for one dictation run: the renderer never
 *  holds the real key, and audio flows renderer → Deepgram directly. The TTL
 *  is 300s because a run can outlast the 30s default; Deepgram checks the
 *  token only at the WebSocket handshake. The key needs ≥ Member permission
 *  to call /auth/grant (plain transcribe keys get FORBIDDEN). */
export async function mintDictationToken(): Promise<{ ok: true; token: string } | { ok: false; status: 502 | 503; error: string }> {
	const key = keyValue("DEEPGRAM_API_KEY");
	if (!key) return { ok: false, status: 503, error: "No DEEPGRAM_API_KEY — add it to auth.json (desktop) or .env.local (dev)." };
	let res: Response;
	try {
		res = await fetch("https://api.deepgram.com/v1/auth/grant", {
			method: "POST",
			headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ttl_seconds: 300 }),
		});
	} catch {
		return { ok: false, status: 502, error: "Deepgram unreachable" };
	}
	if (!res.ok) {
		const detail = await res.text();
		return { ok: false, status: 502, error: `Deepgram token grant failed (${res.status}): ${detail.slice(0, 200)}` };
	}
	const data = (await res.json()) as { access_token?: string };
	if (!data.access_token) return { ok: false, status: 502, error: "Deepgram grant returned no token" };
	return { ok: true, token: data.access_token };
}
