/**
 * Tool-content click flow (old tests/tool-content-interaction.test.tsx):
 * live math question -> select -> submit -> saved answer -> historical Why.
 *
 * The scripted probe carries KaTeX on the question, the option label and the
 * explanation. The test asserts rendering, the submitted identity, the saved
 * details, and that the historical reveal neither flattens the explanation
 * paragraphs nor mutates the record.
 */
import assert from "node:assert/strict";
import { browser, installApiProbe, apiCalls } from "./frontend-harness.mjs";
import { MATH_LABEL, MATH_QUESTION, MATH_EXPLANATION, EXPLAIN_QUESTION, EXPLAIN_COMMITMENT, EXPLAIN_ANSWER } from "./frontend-mock-provider.mjs";

const TAG = "MATH1";

async function setAgentTools(run, tools) {
	const settings = (await run.jsonApi("/api/settings")).body.settings;
	const { res, body } = await run.jsonApi("/api/settings/agent", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...settings.agent, tools: { ...(settings.agent?.tools ?? {}), ...tools } }),
	});
	assert.equal(res.status, 200, `agent settings → ${res.status} ${JSON.stringify(body)}`);
}

function annotationCount(page) {
	return page.js(`[...document.querySelectorAll('annotation[encoding="application/x-tex"]')].map((node) => node.textContent).filter((text) => text === ${JSON.stringify(String.raw`\nabla f`)}).length`);
}

export async function run(run, check) {
	await check("tool content: live math dock, submit, persisted details, historical Why", async () => {
		const page = browser(run, "tool-content");
		let chatId;
		try {
			await page.goto("/chat/new", { ready: '[data-testid="composer"] textarea' });
			page.fill('[data-testid="composer"] textarea', `Probe me [[MOCK:mathquiz:${TAG}]]`);
			page.press("Enter");
			await page.waitForJs(`location.pathname.startsWith('/chat/') && location.pathname !== '/chat/new'`, 15_000, "chat route created");
			chatId = page.js("location.pathname.split('/').at(-1)");
			await page.waitForJs(`!!document.querySelector('[data-testid=question-dock]')`, 20_000, "question dock");
			if (!(await page.exists('[data-testid="question-dock"]'))) {
				await page.waitForJs(`!!document.querySelector('[data-testid=question-dock]')`, 10_000, "question dock expanded");
			}

			const dock = page.js(`(() => {
				const node = document.querySelector('[data-testid=question-dock]');
				const radios = [...node.querySelectorAll('button[role="radio"]')];
				const mathRadio = radios.findIndex((radio) => !!radio.querySelector('.katex'));
				return {
					mtr: node.querySelectorAll('mtr').length,
					katexErrors: node.querySelectorAll('.katex-error').length,
					radios: radios.length,
					mathRadio,
					text: node.innerText,
				};
			})()`);
			assert.equal(dock.mtr, 2, `live question matrix rows drifted: ${dock.mtr}`);
			assert.equal(dock.katexErrors, 0, "live question rendered a KaTeX error");
			assert.ok(dock.mathRadio >= 0, "no option rendered the KaTeX label");
			assert.ok(dock.text.includes("Find"), "the question text is missing from the dock");

			page.js(`(() => {
				const radios = [...document.querySelectorAll('[data-testid=question-dock] button[role="radio"]')];
				radios.find((radio) => !!radio.querySelector('.katex')).click();
				return true;
			})()`);
			const checked = page.js(`[...document.querySelectorAll('[data-testid=question-dock] button[role="radio"]')].map((radio) => radio.getAttribute('aria-checked'))`);
			assert.ok(checked.includes("true"), "the math option did not become checked");
			page.click('[data-testid="question-dock"] button[type="submit"]');
			await page.waitForJs(`!!document.querySelector('[data-testid=answered-card]')`, 20_000, "answered card");
			const answered = await page.q('[data-testid="answered-card"]');
			assert.match(answered, /correct/i, "the answered card does not show the correct verdict");

			const started = Date.now();
			let request;
			while (Date.now() < started + 20_000) {
				request = run.mock.requests.filter((entry) => entry.tag === TAG).at(-1);
				if (request?.hasFunctionOutput && request.completed) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			assert.ok(request?.hasFunctionOutput && request.completed, "the mocked reaction turn never completed");
			const record = await run.waitSettled(chatId);
			const result = record.messages.find((message) => message.role === "toolResult" && message.toolCallId?.includes(`call_math_${TAG}`));
			assert.ok(result, "the probe tool result was not persisted");
			assert.ok(result.details, "the probe details were not persisted");
			assert.equal(result.details.questionText, MATH_QUESTION, "saved question text was altered");
			assert.equal(result.details.explanation, MATH_EXPLANATION, "saved explanation was altered");
			assert.equal(result.details.answers?.[0]?.value, MATH_LABEL, "the submitted identity was altered");
			assert.equal(result.details.answers?.[0]?.label, MATH_LABEL, "the submitted label was altered");
			assert.equal(result.details.correct, true, "the answer was not graded correct");
			const saved = JSON.stringify(result.details);
			assert.ok(JSON.stringify(record.messages).includes(`SEG_${TAG}_03`), "the mocked reaction reply was not persisted");

			await page.goto(`/chat/${chatId}`, { ready: '[data-testid="answered-card"]' });
			const reloaded = await run.getChat(chatId);
			const reloadedResult = reloaded.messages.find((message) => message.role === "toolResult" && message.toolCallId?.includes(`call_math_${TAG}`));
			assert.equal(JSON.stringify(reloadedResult.details), saved, "the saved details changed across reload");
			installApiProbe(page);
			const beforeWhy = page.js(`({ mtr: document.querySelectorAll('mtr').length, annotations: [...document.querySelectorAll('annotation[encoding="application/x-tex"]')].map((node) => node.textContent).filter((text) => text === ${JSON.stringify(String.raw`\nabla f`)}).length })`);
			page.clickText('[data-testid="tucked-explanation"] button', "Why");
			await page.waitForJs(`document.querySelectorAll('[data-testid=tucked-explanation] p').length === 2`, 8_000, "two explanation paragraphs");
			const why = page.js(`(() => {
				const tucked = document.querySelector('[data-testid=tucked-explanation]');
				const first = tucked.querySelector('p');
				return {
					paragraphs: tucked.querySelectorAll('p').length,
					mtr: document.querySelectorAll('mtr').length,
					katexErrors: document.querySelectorAll('.katex-error').length,
					parentClass: first?.parentElement?.className ?? null,
					text: tucked.innerText,
				};
			})()`);
			assert.equal(why.paragraphs, 2, "the historical reveal flattened or split the explanation paragraphs");
			assert.equal(why.mtr, beforeWhy.mtr + 2, `the explanation matrix rows did not appear: ${beforeWhy.mtr} -> ${why.mtr}`);
			assert.equal(why.katexErrors, 0, "the historical reveal rendered a KaTeX error");
			assert.ok(why.parentClass?.includes("[&>p:first-child]:inline"), "the first revealed paragraph is not inline");
			assert.ok(!why.parentClass?.includes("[&_p]:inline"), "the reveal flattened every paragraph inline");
			assert.equal(await annotationCount(page), beforeWhy.annotations + 1, "the recovered explanation math annotation did not appear");
			const afterWhy = await run.getChat(chatId);
			const afterResult = afterWhy.messages.find((message) => message.role === "toolResult" && message.toolCallId?.includes(`call_math_${TAG}`));
			assert.equal(JSON.stringify(afterResult.details), saved, "opening Why mutated the saved answer");
			const writes = apiCalls(page).filter((call) => call.method !== "GET");
			assert.deepEqual(writes, [], "opening Why wrote to the API");
			page.screenshot("tool-content-01-why");
			return { chatId, dock, why: { paragraphs: why.paragraphs, mtr: why.mtr }, savedLength: saved.length };
		} finally {
			page.close();
		}
	});

	await check("tool content: committed explain reveal keeps the first paragraph inline without flattening later paragraphs", async () => {
		await setAgentTools(run, { explain: true });
		const page = browser(run, "tool-content-explain");
		const tag = "EXPLAIN1";
		let chatId;
		try {
			await page.goto("/chat/new", { ready: '[data-testid="composer"] textarea' });
			page.fill('[data-testid="composer"] textarea', `Explain probe [[MOCK:explain:${tag}]]`);
			page.press("Enter");
			await page.waitForJs(`location.pathname.startsWith('/chat/') && location.pathname !== '/chat/new'`, 15_000, "chat route created");
			chatId = page.js("location.pathname.split('/').at(-1)");
			await page.waitForJs(`!!document.querySelector('[data-testid=question-dock]')`, 20_000, "explain question dock");
			const dock = page.js(`(() => {
				const node = document.querySelector('[data-testid=question-dock]');
				return {
					label: node.innerText.split('\\n').find((line) => line.trim().length > 0) ?? null,
					answerField: !!node.querySelector('[data-testid=answer-field] textarea'),
					text: node.innerText,
				};
			})()`);
			assert.equal(dock.label, "RECALL", `the free-recall dock lost its label: ${dock.label}`);
			assert.equal(dock.answerField, true, "the explain dock lost its free-text answer field");
			assert.ok(dock.text.includes("points uphill"), `the explain question text is missing: ${JSON.stringify(dock.text)}`);

			page.fill('[data-testid="answer-field"] textarea', EXPLAIN_ANSWER);
			page.clickText('[data-testid="question-dock"] button', "Submit answer");
			await page.waitForJs(`!!document.querySelector('[data-testid=answered-card]')`, 20_000, "answered card");
			const card = page.js(`(() => {
				const card = document.querySelector('[data-testid=answered-card]');
				const paragraphs = [...card.querySelectorAll('p')];
				return {
					paragraphs: paragraphs.length,
					firstParentClass: paragraphs[1]?.parentElement?.className ?? null,
					katexErrors: card.querySelectorAll('.katex-error').length,
					katex: card.querySelectorAll('.katex').length,
					text: card.innerText,
					tucked: !!card.querySelector('[data-testid=tucked-explanation]'),
				};
			})()`);
			assert.equal(card.paragraphs, 3, `expected the question plus two committed-answer paragraphs, saw ${card.paragraphs}`);
			assert.ok(card.firstParentClass?.includes("[&>p:first-child]:inline"), "the committed first paragraph is not inline");
			assert.ok(!card.firstParentClass?.includes("[&_p]:inline"), "the committed reveal flattened every paragraph inline");
			assert.equal(card.katexErrors, 0, "the committed reveal rendered a KaTeX error");
			assert.ok(card.katex > 0, "the committed reveal rendered no KaTeX");
			assert.equal(card.tucked, false, "the explain card rendered the quiz-only Why affordance");
			assert.ok(card.text.includes("The answer:"), "the committed reveal lost its label");
			assert.ok(card.text.includes("steepest ascent"), "the committed answer text is missing");

			const settled = await run.waitSettled(chatId);
			const result = settled.messages.find((message) => message.role === "toolResult" && message.toolCallId?.includes(tag));
			assert.ok(result, "the explain result was not persisted");
			assert.equal(result.details.kind, "explain", `the saved answer kind drifted: ${result.details.kind}`);
			assert.equal(result.details.tool, "recall", `the saved tool name drifted: ${result.details.tool}`);
			assert.equal(result.details.questionText, EXPLAIN_QUESTION, "the saved question text was altered");
			assert.equal(result.details.committed, EXPLAIN_COMMITMENT, "the saved commitment was altered");
			assert.equal(result.details.text, EXPLAIN_ANSWER, "the learner's saved answer was altered");
			const call = settled.messages
				.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
				.find((part) => part.type === "toolCall" && part.id === result.toolCallId);
			assert.ok(call, "the explain tool call was not persisted");
			assert.equal(call.arguments.correctAnswer, EXPLAIN_COMMITMENT, "the committed source arguments were mutated");
			assert.equal(call.arguments.question, EXPLAIN_QUESTION, "the committed source question was mutated");
			const saved = JSON.stringify(result.details);

			await page.goto(`/chat/${chatId}`, { ready: '[data-testid="answered-card"]' });
			const reloaded = await page.js(`(() => {
				const card = document.querySelector('[data-testid=answered-card]');
				const paragraphs = [...card.querySelectorAll('p')];
				return { paragraphs: paragraphs.length, firstParentClass: paragraphs[1]?.parentElement?.className ?? null, committed: card.innerText.includes('steepest ascent') };
			})()`);
			assert.equal(reloaded.paragraphs, 3, "the reloaded committed reveal changed its paragraph count");
			assert.ok(reloaded.firstParentClass?.includes("[&>p:first-child]:inline"), "the reloaded committed reveal lost the inline-first paragraph");
			assert.ok(!reloaded.firstParentClass?.includes("[&_p]:inline"), "the reloaded committed reveal flattened every paragraph");
			assert.equal(reloaded.committed, true, "the reloaded card lost the committed answer");
			const after = await run.getChat(chatId);
			const afterResult = after.messages.find((message) => message.role === "toolResult" && message.toolCallId?.includes(tag));
			assert.equal(JSON.stringify(afterResult.details), saved, "the committed reveal mutated the saved answer");
			page.screenshot("tool-content-02-explain");
			return { chatId, dock: dock.label, card: { paragraphs: card.paragraphs, katex: card.katex }, savedLength: saved.length };
		} finally {
			page.close();
		}
	});
}
