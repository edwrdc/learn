import { createSubscriber } from "svelte/reactivity";

const subscribe = createSubscriber((update) => {
	const timer = setInterval(update, 1000);
	return () => clearInterval(timer);
});

/** The current time, re-read every second by any effect or template using it. */
export function now(): number {
	subscribe();
	return Date.now();
}
