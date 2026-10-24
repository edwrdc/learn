"use client";

import { useEffect, useState } from "react";
import type { CustomEndpointConfig, CustomEndpointModel } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";

interface EndpointState {
	endpoint: CustomEndpointConfig | null;
	keyPresent: boolean;
	keySource: "env" | "file" | "none";
}

interface DiscoveredModel {
	id: string;
	name: string;
}

interface ModelDraft {
	id: string;
	name: string;
	contextWindow: string;
	maxTokens: string;
	reasoning: boolean;
	imageInput: boolean;
}

function draftOf(model: CustomEndpointModel): ModelDraft {
	return {
		id: model.id,
		name: model.name,
		contextWindow: String(model.contextWindow),
		maxTokens: String(model.maxTokens),
		reasoning: model.reasoning,
		imageInput: model.imageInput,
	};
}

function safeId(id: string): string {
	return id.replace(/[^a-z0-9-]/gi, "_");
}

export function CustomEndpointSection({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [state, setState] = useState<EndpointState | null>(null);
	const [displayName, setDisplayName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [drafts, setDrafts] = useState<ModelDraft[]>([]);
	const [discovered, setDiscovered] = useState<DiscoveredModel[]>([]);
	const [manualId, setManualId] = useState("");
	const [busy, setBusy] = useState<"save" | "fetch" | "delete" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	async function reload(): Promise<EndpointState | null> {
		const res = await fetch("/api/custom-endpoint").catch(() => null);
		if (!res || !res.ok) {
			setError("Could not load the custom endpoint.");
			return null;
		}
		const body = (await res.json()) as EndpointState;
		setState(body);
		return body;
	}

	useEffect(() => {
		void reload();
	}, []);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			onOpenChange(false);
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [open, onOpenChange]);

	useEffect(() => {
		if (!state || !open) return;
		setDisplayName(state.endpoint?.displayName ?? "");
		setBaseUrl(state.endpoint?.baseUrl ?? "");
		setDrafts((state.endpoint?.models ?? []).map(draftOf));
		setApiKey("");
		setDiscovered([]);
		setManualId("");
		setError(null);
		setNotice(null);
	}, [open, state]);

	function addDiscovered(model: DiscoveredModel) {
		if (drafts.some((d) => d.id === model.id)) return;
		setDrafts((prev) => [
			...prev,
			{ id: model.id, name: model.name, contextWindow: "", maxTokens: "", reasoning: false, imageInput: false },
		]);
	}

	function removeDraft(id: string) {
		setDrafts((prev) => prev.filter((d) => d.id !== id));
	}

	function addManual() {
		const id = manualId.trim();
		if (!id) return;
		if (drafts.some((d) => d.id === id)) {
			setError(`Model "${id}" is already configured.`);
			return;
		}
		setDrafts((prev) => [
			...prev,
			{ id, name: id, contextWindow: "", maxTokens: "", reasoning: false, imageInput: false },
		]);
		setManualId("");
		setError(null);
	}

	function patchDraft(id: string, patch: Partial<ModelDraft>) {
		setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
	}

	async function fetchModels() {
		if (busy) return;
		setBusy("fetch");
		setError(null);
		setNotice(null);
		const res = await fetch("/api/custom-endpoint/models", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ baseUrl, ...(apiKey.trim() ? { apiKey } : {}) }),
		}).catch(() => null);
		setBusy(null);
		if (!res) {
			setError("Could not reach the server — try again.");
			return;
		}
		const body = (await res.json().catch(() => ({}))) as { models?: DiscoveredModel[]; error?: string };
		if (!res.ok) {
			setError(body.error ?? `Model discovery failed (${res.status})`);
			return;
		}
		setDiscovered(body.models ?? []);
		setNotice(
			(body.models ?? []).length === 0
				? "The endpoint returned no models — add one manually below."
				: `${(body.models ?? []).length} model(s) discovered. Select the ones to configure.`,
		);
	}

	async function save() {
		if (busy) return;
		setBusy("save");
		setError(null);
		setNotice(null);
		const models = drafts.map((d) => ({
			id: d.id,
			name: d.name,
			contextWindow: Number(d.contextWindow),
			maxTokens: Number(d.maxTokens),
			reasoning: d.reasoning,
			imageInput: d.imageInput,
		}));
		const res = await fetch("/api/custom-endpoint", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				displayName,
				baseUrl,
				models,
				...(apiKey.trim() ? { apiKey } : {}),
			}),
		}).catch(() => null);
		setBusy(null);
		if (!res) {
			setError("Could not reach the server — try again.");
			return;
		}
		const body = (await res.json().catch(() => ({}))) as EndpointState & { error?: string };
		if (!res.ok) {
			setError(body.error ?? `Save failed (${res.status})`);
			return;
		}
		setState(body);
		setApiKey("");
		setNotice("Custom endpoint saved.");
		notifySettingsSaved("models");
		notifySettingsSaved("keys");
	}

	async function remove() {
		if (busy) return;
		setBusy("delete");
		setError(null);
		setNotice(null);
		const res = await fetch("/api/custom-endpoint", { method: "DELETE" }).catch(() => null);
		setBusy(null);
		if (!res || !res.ok) {
			setError("Could not remove the endpoint — try again.");
			return;
		}
		const body = (await res.json()) as EndpointState;
		setState(body);
		onOpenChange(false);
		notifySettingsSaved("models");
		notifySettingsSaved("keys");
	}

	const envOwnedKey = state?.keySource === "env";
	const configured = state?.endpoint ?? null;
	const status = !configured
		? "not configured"
		: !state?.keyPresent
			? "key missing"
			: configured.models.length === 1
				? "1 model"
				: `${configured.models.length} models`;

	return (
		<div data-testid="custom-endpoint">
			<button
				type="button"
				aria-expanded={open}
				data-testid="custom-endpoint-row"
				onClick={() => onOpenChange(!open)}
				className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left transition-colors hover:bg-accent/50"
			>
				<span className="font-ui text-xs text-foreground">{configured?.displayName ?? "Custom endpoint"}</span>
				<span data-testid="custom-endpoint-status" className="font-mono text-[11px] text-muted-foreground">
					{status}
				</span>
			</button>

			{open && (
				<div data-testid="custom-endpoint-form" className="mt-1 flex flex-col gap-2 px-1 pb-2">
					<div className="flex items-center gap-2">
						<label htmlFor="custom-endpoint-display-name" className="w-28 shrink-0 font-ui text-xs text-muted-foreground">
							Display name
						</label>
						<input
							id="custom-endpoint-display-name"
							data-testid="custom-endpoint-display-name"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
							placeholder="My endpoint"
							disabled={busy !== null}
							className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
						/>
					</div>
					<div className="flex items-center gap-2">
						<label htmlFor="custom-endpoint-base-url" className="w-28 shrink-0 font-ui text-xs text-muted-foreground">
							Base URL
						</label>
						<input
							id="custom-endpoint-base-url"
							data-testid="custom-endpoint-base-url"
							value={baseUrl}
							onChange={(e) => setBaseUrl(e.target.value)}
							placeholder="https://host/v1"
							disabled={busy !== null}
							spellCheck={false}
							className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
						/>
					</div>
					<div className="flex items-center gap-2">
						<label htmlFor="custom-endpoint-api-key" className="w-28 shrink-0 font-ui text-xs text-muted-foreground">
							API key
						</label>
						<input
							id="custom-endpoint-api-key"
							data-testid="custom-endpoint-api-key"
							type="password"
							value={envOwnedKey ? "" : apiKey}
							onChange={(e) => setApiKey(e.target.value)}
							placeholder={
								envOwnedKey
									? "From environment (read-only)"
									: state?.keyPresent
										? "Saved — leave blank to keep"
										: "Paste key…"
							}
							autoComplete="off"
							disabled={busy !== null || envOwnedKey}
							className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50 disabled:opacity-60"
						/>
					</div>
					{envOwnedKey && (
						<p data-testid="custom-endpoint-env-key" className="pl-[7.5rem] text-[11px] text-muted-foreground">
							LH_CUSTOM_ENDPOINT_API_KEY owns this key. Unset it to edit the key or change the base URL.
						</p>
					)}

					<div className="flex flex-wrap items-center gap-3 pt-1">
						<button
							type="button"
							data-testid="custom-endpoint-fetch"
							onClick={() => void fetchModels()}
							disabled={busy !== null || !baseUrl.trim()}
							className="text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline"
						>
							{busy === "fetch" ? "Fetching…" : "Fetch models"}
						</button>
						<button
							type="button"
							data-testid="custom-endpoint-save"
							onClick={() => void save()}
							disabled={busy !== null}
							className="text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline"
						>
							{busy === "save" ? "Saving…" : "Save"}
						</button>
						{configured && (
							<button
								type="button"
								data-testid="custom-endpoint-delete"
								onClick={() => void remove()}
								disabled={busy !== null}
								className="ml-auto text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline disabled:text-muted-foreground/40 disabled:no-underline"
							>
								Remove endpoint
							</button>
						)}
					</div>

					{error && (
						<p role="alert" data-testid="custom-endpoint-error" className="text-xs text-red-500">
							{error}
						</p>
					)}
					{notice && (
						<p data-testid="custom-endpoint-notice" className="text-xs text-muted-foreground">
							{notice}
						</p>
					)}

					{drafts.length > 0 && (
						<div data-testid="custom-endpoint-models" className="mt-1 flex flex-col gap-2 border-t border-border/60 pt-2">
							<p className="text-[10px] uppercase tracking-widest text-muted-foreground">Configured models</p>
							{drafts.map((d) => {
								const safe = safeId(d.id);
								return (
									<div key={d.id} data-testid={`custom-endpoint-model-${safe}`} className="flex flex-col gap-1.5 rounded-sm border border-border/60 p-2">
										<div className="flex items-center justify-between gap-2">
											<span className="min-w-0 truncate font-mono text-xs text-foreground">{d.id}</span>
											<button
												type="button"
												data-testid={`custom-endpoint-model-${safe}-remove`}
												onClick={() => removeDraft(d.id)}
												disabled={busy !== null}
												className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline"
											>
												Remove
											</button>
										</div>
										<div className="flex flex-wrap items-center gap-3">
											<label className="flex items-center gap-1.5 font-ui text-xs text-muted-foreground">
												Context tokens
												<input
													type="number"
													min={1}
													data-testid={`custom-endpoint-model-${safe}-context`}
													value={d.contextWindow}
													onChange={(e) => patchDraft(d.id, { contextWindow: e.target.value })}
													disabled={busy !== null}
													className="h-7 w-28 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none"
												/>
											</label>
											<label className="flex items-center gap-1.5 font-ui text-xs text-muted-foreground">
												Max output
												<input
													type="number"
													min={1}
													data-testid={`custom-endpoint-model-${safe}-max`}
													value={d.maxTokens}
													onChange={(e) => patchDraft(d.id, { maxTokens: e.target.value })}
													disabled={busy !== null}
													className="h-7 w-28 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none"
												/>
											</label>
											<label className="flex items-center gap-1.5 font-ui text-xs text-muted-foreground">
												<input
													type="checkbox"
													data-testid={`custom-endpoint-model-${safe}-reasoning`}
													checked={d.reasoning}
													onChange={(e) => patchDraft(d.id, { reasoning: e.target.checked })}
													disabled={busy !== null}
												/>
												Reasoning
											</label>
											<label className="flex items-center gap-1.5 font-ui text-xs text-muted-foreground">
												<input
													type="checkbox"
													data-testid={`custom-endpoint-model-${safe}-image`}
													checked={d.imageInput}
													onChange={(e) => patchDraft(d.id, { imageInput: e.target.checked })}
													disabled={busy !== null}
												/>
												Image input
											</label>
										</div>
									</div>
								);
							})}
						</div>
					)}

					{discovered.length > 0 && (
						<div data-testid="custom-endpoint-discovered" className="mt-1 flex flex-col gap-1 border-t border-border/60 pt-2">
							<p className="text-[10px] uppercase tracking-widest text-muted-foreground">Discovered models</p>
							<div className="flex max-h-40 flex-col overflow-y-auto">
								{discovered.map((m) => {
									const selected = drafts.some((d) => d.id === m.id);
									return (
										<label key={m.id} className="flex items-center gap-2 rounded-sm px-1 py-1 font-ui text-xs text-foreground hover:bg-accent/40">
											<input
												type="checkbox"
												data-testid={`custom-endpoint-discovered-${safeId(m.id)}`}
												checked={selected}
												onChange={() => (selected ? removeDraft(m.id) : addDiscovered(m))}
												disabled={busy !== null}
											/>
											<span className="min-w-0 truncate">{m.name}</span>
											{m.name !== m.id && <span className="ml-auto min-w-0 truncate font-mono text-[10px] text-muted-foreground">{m.id}</span>}
										</label>
									);
								})}
							</div>
						</div>
					)}

					<div className="mt-1 flex items-center gap-2 border-t border-border/60 pt-2">
						<label htmlFor="custom-endpoint-manual-id" className="shrink-0 font-ui text-xs text-muted-foreground">
							Add model
						</label>
						<input
							id="custom-endpoint-manual-id"
							data-testid="custom-endpoint-manual-id"
							value={manualId}
							onChange={(e) => setManualId(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") addManual();
							}}
							placeholder="model-id"
							disabled={busy !== null}
							className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
						/>
						<button
							type="button"
							data-testid="custom-endpoint-manual-add"
							onClick={addManual}
							disabled={busy !== null || !manualId.trim()}
							className="shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline"
						>
							Add
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
