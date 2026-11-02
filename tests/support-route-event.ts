/**
 * Drive a +server.ts handler directly. The route handlers read only `request`,
 * `params` and `url` from SvelteKit's RequestEvent, so the test builds exactly
 * those; `never` satisfies each route's generated event type without pretending
 * the test is a full SvelteKit request.
 */
export function routeEvent(request: Request, params: Record<string, string | string[]> = {}): never {
	return { request, params, url: new URL(request.url) } as never;
}
