/** Display-only SVG repairs for the image-document boundary. */
export function svgImageSource(source: string): string {
	let foundRoot = false;
	const pattern = new RegExp(
		"<!--[\\s\\S]*?(?:-->|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>|$)|<\\?[\\s\\S]*?(?:\\?>|$)|<\\/?[a-zA-Z](?:[^<>\"']|\"[^\"]*\"|'[^']*')*>|&nbsp;",
		"g",
	);
	return source.replace(
		pattern,
		(token) => {
			if (token.startsWith("<!--") || token.startsWith("<![CDATA[") || token.startsWith("<?")) return token;
			if (!foundRoot && /^<svg(?=[\s/>])/i.test(token)) {
				foundRoot = true;
				const attrs = token.matchAll(/\s([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g);
				const hasNamespace = Array.from(attrs).some((attr) => attr[1] === "xmlns");
				if (!hasNamespace) token = token.replace(/^<svg/i, '$& xmlns="http://www.w3.org/2000/svg"');
			}
			return token.replace(/&nbsp;/g, "&#160;");
		},
	);
}
