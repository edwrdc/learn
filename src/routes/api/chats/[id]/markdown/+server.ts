/**
 * GET /api/chats/:id/markdown → the whole session as one markdown file
 * (Content-Disposition attachment; filename from the slugified title); 404
 * unknown chat. The same document the extractor reads, minted anchorless
 * (anchors are extraction provenance; a learner's export carries no message
 * ids). Practice sessions export through the same engine.
 */
import { sessionMarkdown } from "@/src/session/model";
import { requireChat } from "@/src/session";
import type { RequestEvent } from "./$types";

/** Filename-safe title. */
function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "session";
}

export async function GET({ params }: RequestEvent): Promise<Response> {
	const { id } = params;
	const record = await requireChat(id);
	if (record instanceof Response) return record;
	const markdown = sessionMarkdown(record.messages, { title: record.title, anchors: false });
	return new Response(markdown, {
		headers: {
			"content-type": "text/markdown; charset=utf-8",
			"content-disposition": `attachment; filename="${slugify(record.title)}.md"`,
		},
	});
}
