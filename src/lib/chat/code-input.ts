export function withCode(text: string, code: string): string {
	if (!code.trim()) return text;
	const fence = "`".repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map((run) => run.length + 1)));
	return `${text.trim()}${text.trim() ? "\n\n" : ""}${fence}\n${code}\n${fence}`;
}

export function codeKeydown(
	event: KeyboardEvent & { currentTarget: HTMLTextAreaElement },
	onChange: (value: string) => void,
	onSubmit: () => void,
	onEscape?: () => void,
): void {
	if (event.key === "Tab") {
		event.stopPropagation();
		if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
		event.preventDefault();
		const field = event.currentTarget;
		field.setRangeText("    ", field.selectionStart, field.selectionEnd, "end");
		onChange(field.value);
	} else if (event.key === "Enter") {
		event.stopPropagation();
		if (event.isComposing || !(event.ctrlKey || event.metaKey)) return;
		event.preventDefault();
		onSubmit();
	} else if (event.key === "Escape" && onEscape) {
		event.preventDefault();
		event.stopPropagation();
		onEscape();
	}
}
