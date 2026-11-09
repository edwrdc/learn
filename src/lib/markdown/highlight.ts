let highlighter: Promise<{ codeToHtml: (code: string, opts: { lang: string; theme: string }) => Promise<string> }> | null = null;

const ALIAS: Record<string, string> = {
	js: "javascript",
	jsx: "jsx",
	ts: "typescript",
	tsx: "tsx",
	py: "python",
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	yml: "yaml",
	md: "markdown",
	html: "html",
	css: "css",
	json: "json",
	sql: "sql",
	go: "go",
	rust: "rust",
	rs: "rust",
	java: "java",
	c: "c",
	cpp: "cpp",
	csharp: "csharp",
	cs: "csharp",
	ruby: "ruby",
	rb: "ruby",
	php: "php",
	swift: "swift",
	kotlin: "kotlin",
	xml: "xml",
	toml: "toml",
	diff: "diff",
};

function bundledLanguage(lang: string): string {
	const key = lang.trim().toLowerCase();
	if (!key) return "text";
	return ALIAS[key] ?? key;
}

/** Highlight one fence to the inner code HTML (shiki, github-dark). The classic <pre><code>
 *  wrapper is stripped so the app's own body markup stays the shell.
 *  Unknown languages fall back to escaped text, never an error. */
export async function highlightCode(source: string, lang: string): Promise<string | null> {
	if (typeof window === "undefined") return null;
	const language = bundledLanguage(lang);
	try {
		highlighter ??= import("shiki").then((mod) => ({
			codeToHtml: (code, opts) => mod.codeToHtml(code, opts),
		}));
		const { codeToHtml } = await highlighter;
		const html = await codeToHtml(source, { lang: language, theme: "github-dark" });
		return /<code[^>]*>([\s\S]*)<\/code>/.exec(html)?.[1] ?? null;
	} catch (error) {
		console.error(`[highlight] ${language} failed:`, error);
		return null;
	}
}
