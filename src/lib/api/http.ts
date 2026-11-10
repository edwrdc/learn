/** A non-2xx answer: the server's `{error, code, ...}` body rides along so
 *  callers can switch on the code (refusal envelopes, delete gates). */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly body: { error?: string; code?: string; [key: string]: unknown } | null,
	) {
		super(body?.error ?? `request failed (${status})`);
		this.name = "ApiError";
	}
}

/** Path segments are always encoded. */
export function path(strings: TemplateStringsArray, ...ids: string[]): string {
	return strings.reduce((out, part, i) => out + part + (i < ids.length ? encodeURIComponent(ids[i]!) : ""), "");
}

async function call<T>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
	const res = await fetch(url, {
		...init,
		method,
		...(body === undefined
			? {}
			: body instanceof FormData
				? { body }
				: { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
	});
	const parsed = (await res.json().catch(() => null)) as T | null;
	if (!res.ok) throw new ApiError(res.status, parsed as ApiError["body"]);
	return parsed as T;
}

export const getJson = <T>(url: string, init?: RequestInit) => call<T>("GET", url, undefined, init);
export const postJson = <T>(url: string, body?: unknown) => call<T>("POST", url, body);
export const putJson = <T>(url: string, body: unknown) => call<T>("PUT", url, body);
export const deleteJson = <T>(url: string) => call<T>("DELETE", url);

/** A refused request shows the server's reason; anything else (the
 *  network, a bug) shows the caller's fallback. */
export function failureMessage(err: unknown, fallback: string): string {
	return err instanceof ApiError ? err.message : fallback;
}
