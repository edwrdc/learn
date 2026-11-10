/** An error that unwinds a run the way an abort does. */
export function abortError(message: string, options?: ErrorOptions): Error {
	const error = new Error(message, options);
	error.name = "AbortError";
	return error;
}

export function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
