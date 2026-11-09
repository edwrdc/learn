interface LhChatOperationsGlobal {
	__lhChatOperationQueues?: Map<string, Promise<unknown>>;
}

// Admission/deletion queue first, store queues inside. Never await same-chat reentry.
// shortcut: process-local ordering, coordinate shared storage before multi-process serving.
export async function withChatOperation<T>(chatId: string, run: () => Promise<T>): Promise<T> {
	const g = globalThis as typeof globalThis & LhChatOperationsGlobal;
	const queues = (g.__lhChatOperationQueues ??= new Map());
	const previous = queues.get(chatId) ?? Promise.resolve();
	const result = previous.then(run, run);
	const tail = result.catch(() => undefined);
	queues.set(chatId, tail);
	try {
		return await result;
	} finally {
		if (queues.get(chatId) === tail) queues.delete(chatId);
	}
}
