import { parseModelKey } from "@/src/settings/model";

/** Money/token presentation helpers. */
export function formatUsd(value: number): string {
	return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

export function formatTokens(n: number): string {
	if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
	return String(n);
}

export function prettyModel(id: string, qualified = false): string {
	const { provider, id: bare } = parseModelKey(id);
	const short = bare.includes("/") ? bare.slice(bare.lastIndexOf("/") + 1) : bare;
	const parts = short.split("-");
	const trimmed = /^\d+$/.test(parts[parts.length - 1] ?? "") ? parts.slice(0, -1) : parts;
	const pretty = trimmed.join("-");
	return qualified && provider ? `${pretty} · ${provider}` : pretty;
}

export function timeAgo(iso: string, now = new Date()): string {
	const ms = now.getTime() - new Date(iso).getTime();
	if (ms < 60_000) return "just now";
	const min = Math.floor(ms / 60_000);
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 7) return `${d}d ago`;
	const date = new Date(iso);
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${mm}-${dd}`;
}
