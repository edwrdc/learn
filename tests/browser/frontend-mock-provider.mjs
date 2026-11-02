/**
 * Local scripted OpenAI Responses provider for the frontend interaction
 * harness. Binds 127.0.0.1 only, makes no external calls, and is not a model.
 *
 * Modes come from the LAST [[MOCK:<mode>:<tag>]] marker in the request body:
 *   fast          three short text deltas
 *   mathquiz      one `probe` function call carrying KaTeX matrix content
 *   explain       one `recall` (free-recall explain) function call with a
 *                 two-paragraph committed answer
 *   research      one `research` background-job call whose question carries
 *                 the slow-researcher marker
 *   researchslow  an 8s text stream (the researcher job's observable window);
 *                 fast when the request already carries a function result
 * A request that already carries a function_call_output (the answer/reaction
 * turn) gets fast text, so the scripted turn always completes.
 */
import * as http from "node:http";

const MARKER = /\[\[MOCK:([a-z]+):([A-Za-z0-9]+)\]\]/g;

// Synthetic fixture content only: one LaTeX matrix in the question and one in
// the explanation, the examined option labelled with KaTeX, two paragraphs.
export const MATH_LABEL = String.raw`$\nabla f$`;
export const MATH_QUESTION = String.raw`Find $\nabla f$ for $\begin{pmatrix}a&b\\c&d\end{pmatrix}$.`;
export const MATH_EXPLANATION = "First paragraph.\n\nThe matrix is $\\begin{pmatrix}p&q\\\\r&s\\end{pmatrix}$ and $\\nabla f$ is its gradient.";

const MATH_ARGS = JSON.stringify({
	question: MATH_QUESTION,
	options: [
		{ label: MATH_LABEL, value: MATH_LABEL },
		{ label: "no", value: "no" },
	],
	correctAnswer: MATH_LABEL,
	explanation: MATH_EXPLANATION,
});

// Synthetic explain (free-recall) content: one KaTeX question, a two-paragraph
// committed answer (the reveal), and a one-line learner answer.
export const EXPLAIN_QUESTION = String.raw`Explain why $\nabla f$ points uphill for $f(x,y)=x^2+y^2$.`;
export const EXPLAIN_COMMITMENT = String.raw`The gradient $\nabla f$ is the direction of steepest ascent.

For $\begin{pmatrix}a&b\\c&d\end{pmatrix}$ the same rule holds: move along the gradient to increase $f$.`;
export const EXPLAIN_ANSWER = "The gradient points toward increasing values.";

export const RESEARCH_QUESTION = "Synthetic probe: which loopback facts hold?";
export const RESEARCH_BRIEF = "Synthetic brief: the loopback mock answered without network access.";

function functionCall(res, { callId, itemId, name, args }) {
	const item = {
		id: itemId,
		type: "function_call",
		status: "completed",
		call_id: callId,
		name,
		arguments: args,
	};
	sse(res, "response.output_item.added", {
		type: "response.output_item.added",
		output_index: 0,
		item: { ...item, status: "in_progress", arguments: "" },
	});
	sse(res, "response.function_call_arguments.delta", {
		type: "response.function_call_arguments.delta",
		output_index: 0,
		item_id: item.id,
		delta: args,
	});
	sse(res, "response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
}

function sse(res, event, data) {
	if (res.destroyed || res.writableEnded) return false;
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	return true;
}

export function mockProvider() {
	const requests = [];
	const sockets = new Set();
	let id = 0;
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const pathname = new URL(req.url, "http://127.0.0.1").pathname;
			if (req.method === "GET" && pathname === "/__state") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(requests));
				return;
			}
			if (req.method !== "POST" || !pathname.endsWith("/responses")) {
				res.writeHead(404).end();
				return;
			}
			const marker = [...body.matchAll(MARKER)].at(-1);
			const mode = marker?.[1] ?? "unknown";
			const tag = marker?.[2] ?? "unknown";
			const callId = `call_${mode}_${tag}`;
			const record = {
				mode,
				tag,
				authorization: req.headers.authorization ?? null,
				startedAt: new Date().toISOString(),
				segments: 0,
				completed: false,
				aborted: false,
				hasFunctionOutput: body.includes('"function_call_output"'),
			};
			requests.push(record);
			if (!["fast", "mathquiz", "explain", "research", "researchslow"].includes(mode)) {
				res.writeHead(400).end("unknown mock mode");
				return;
			}
			const n = ++id;
			const itemId = `msg_${n}`;
			const responseId = `resp_${n}`;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			res.flushHeaders();
			sse(res, "response.created", { type: "response.created", response: { id: responseId, object: "response", status: "in_progress" } });

			if (!record.hasFunctionOutput && (mode === "mathquiz" || mode === "explain" || mode === "research")) {
				const spec = mode === "mathquiz"
					? { itemId: `fc_math_${tag}`, name: "probe", args: MATH_ARGS, callId: `call_math_${tag}` }
					: mode === "explain"
						? { itemId: `fc_explain_${tag}`, name: "recall", args: JSON.stringify({ question: EXPLAIN_QUESTION, correctAnswer: EXPLAIN_COMMITMENT }), callId }
						: { itemId: `fc_research_${tag}`, name: "research", args: JSON.stringify({ question: `${RESEARCH_QUESTION} [[MOCK:researchslow:${tag}]]`, context: "Synthetic loopback probe." }), callId };
				functionCall(res, spec);
				sse(res, "response.completed", {
					type: "response.completed",
					response: {
						id: responseId,
						object: "response",
						status: "completed",
						output: [{ id: spec.itemId, type: "function_call", status: "completed", call_id: spec.callId, name: spec.name, arguments: spec.args }],
						usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, input_tokens_details: { cached_tokens: 0 } },
					},
				});
				record.completed = true;
				res.end();
				return;
			}

			sse(res, "response.output_item.added", {
				type: "response.output_item.added",
				output_index: 0,
				item: { id: itemId, type: "message", role: "assistant", content: [] },
			});
			res.on("close", () => {
				if (!record.completed) record.aborted = true;
			});
			const slow = mode === "researchslow";
			const segments = slow
				? Array.from({ length: 14 }, (_, i) => `RESEARCH_${tag}_${String(i + 1).padStart(2, "0")} `)
				: Array.from({ length: 3 }, (_, i) => `SEG_${tag}_0${i + 1} `);
			void (async () => {
				let text = "";
				for (const delta of segments) {
					if (res.destroyed || res.writableEnded) {
						record.aborted = !record.completed;
						return;
					}
					text += delta;
					record.segments += 1;
					sse(res, "response.output_text.delta", {
						type: "response.output_text.delta",
						output_index: 0,
						item_id: itemId,
						content_index: 0,
						delta,
					});
					await new Promise((resolve) => setTimeout(resolve, slow ? 600 : 20));
				}
				const item = {
					id: itemId,
					type: "message",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: slow ? `${text}\n${RESEARCH_BRIEF}` : text, annotations: [] }],
				};
				sse(res, "response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
				sse(res, "response.completed", {
					type: "response.completed",
					response: {
						id: responseId,
						object: "response",
						status: "completed",
						output: [item],
						usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 0 } },
					},
				});
				record.completed = true;
				res.end();
			})();
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	return {
		requests,
		listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))),
		close: () => new Promise((resolve) => {
			for (const socket of sockets) socket.destroy();
			server.close(() => resolve());
		}),
	};
}
