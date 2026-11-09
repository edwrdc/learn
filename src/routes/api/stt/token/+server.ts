import { mintDictationToken } from "@/src/settings";

export async function GET() {
	const minted = await mintDictationToken();
	if (!minted.ok) return Response.json({ error: minted.error }, { status: minted.status });
	return Response.json({ token: minted.token });
}
