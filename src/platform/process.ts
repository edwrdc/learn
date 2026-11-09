/** Process-wide state that survives a module being loaded twice (Vite's dev
 *  SSR re-instantiates modules on reload while the process keeps running). */
export function processState<T>(key: string, init: () => T): T {
	const slots = globalThis as unknown as Record<symbol, unknown>;
	const slot = Symbol.for(`learnharness.${key}`);
	if (!(slot in slots)) slots[slot] = init();
	return slots[slot] as T;
}
