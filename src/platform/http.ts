export const SSE_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache, no-transform",
	"X-Accel-Buffering": "no",
} as const;

/** A request's JSON body, or the one 400 every route answers bad JSON with. */
export async function readJson(request: Request): Promise<{ body: unknown } | Response> {
	try {
		return { body: await request.json() };
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
}
