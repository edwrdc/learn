/** Process-wide state that survives a module being loaded more than once
 *  (Vite dev SSR and HMR re-evaluate modules; a module-level Map would split). */
export function processState<T>(key: string, init: () => T): T {
	const slots = globalThis as unknown as Record<symbol, unknown>;
	const slot = Symbol.for(`learnharness.${key}`);
	if (!(slot in slots)) slots[slot] = init();
	return slots[slot] as T;
}

/** A per-key FIFO lock: runs for the same key never interleave. Never await
 *  a same-key run from inside one (it would wait on itself). */
export function keyedLock(name: string): <T>(key: string, run: () => Promise<T>) => Promise<T> {
	return async (key, run) => {
		const queues = processState(`lock.${name}`, () => new Map<string, Promise<unknown>>());
		const previous = queues.get(key) ?? Promise.resolve();
		const result = previous.then(run, run);
		const tail = result.catch(() => undefined);
		queues.set(key, tail);
		try {
			return await result;
		} finally {
			if (queues.get(key) === tail) queues.delete(key);
		}
	};
}
