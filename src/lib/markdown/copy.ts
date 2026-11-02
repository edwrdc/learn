/** Clipboard write with the legacy fallback (the desktop clipboard
 *  permission can reject; execCommand still works in the Electron shell). */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
	}
	try {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.appendChild(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		return ok;
	} catch {
		return false;
	}
}

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function lineSpans(source: string): string {
	const lines = source.replace(/\n$/, "").split("\n");
	return lines
		.map((line) => `<span class="line">${escapeHtml(line) || " "}</span>`)
		.join("\n");
}
