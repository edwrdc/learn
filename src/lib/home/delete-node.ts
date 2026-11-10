/** Node-deletion copy seams. */
const EXTRACTION_RETRY_LINE = "An extraction is running — try again when the activity dock drains.";

export function deleteFailureLine(failure: { code: string; error: string }): string {
	return failure.code === "extraction_running" ? EXTRACTION_RETRY_LINE : failure.error;
}
