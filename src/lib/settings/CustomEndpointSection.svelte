<script lang="ts">
	import type { CustomEndpointConfig, CustomEndpointModel } from "@/src/core";
	import { notifySettingsSaved } from "$lib/state/settings-signal";

	interface EndpointState {
		endpoint: CustomEndpointConfig | null;
		keyPresent: boolean;
		keySource: "env" | "file" | "none";
	}
	interface DiscoveredModel { id: string; name: string }
	interface ModelDraft { id: string; name: string; contextWindow: string; maxTokens: string; reasoning: boolean; imageInput: boolean }

	let { open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void } = $props();

	let endpointState = $state<EndpointState | null>(null);
	let displayName = $state("");
	let baseUrl = $state("");
	let apiKey = $state("");
	let drafts = $state<ModelDraft[]>([]);
	let discovered = $state<DiscoveredModel[]>([]);
	let manualId = $state("");
	let busy = $state<"save" | "fetch" | "delete" | null>(null);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);

	function safeId(id: string): string {
		return id.replace(/[^a-z0-9-]/gi, "_");
	}
	function draftOf(model: CustomEndpointModel): ModelDraft {
		return { id: model.id, name: model.name, contextWindow: String(model.contextWindow), maxTokens: String(model.maxTokens), reasoning: model.reasoning, imageInput: model.imageInput };
	}

	async function reload(): Promise<EndpointState | null> {
		const res = await fetch("/api/custom-endpoint").catch(() => null);
		if (!res || !res.ok) {
			error = "Could not load the custom endpoint.";
			return null;
		}
		const body = (await res.json()) as EndpointState;
		endpointState = body;
		return body;
	}

	$effect(() => {
		void reload();
	});

	$effect(() => {
		if (!open || typeof document === "undefined") return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			onOpenChange(false);
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	});

	$effect(() => {
		if (!endpointState || !open) return;
		displayName = endpointState.endpoint?.displayName ?? "";
		baseUrl = endpointState.endpoint?.baseUrl ?? "";
		drafts = (endpointState.endpoint?.models ?? []).map(draftOf);
		apiKey = "";
		discovered = [];
		manualId = "";
		error = null;
		notice = null;
	});

	function addDiscovered(model: DiscoveredModel) {
		if (drafts.some((d) => d.id === model.id)) return;
		drafts = [...drafts, { id: model.id, name: model.name, contextWindow: "", maxTokens: "", reasoning: false, imageInput: false }];
	}
	function removeDraft(id: string) {
		drafts = drafts.filter((d) => d.id !== id);
	}
	function addManual() {
		const id = manualId.trim();
		if (!id) return;
		if (drafts.some((d) => d.id === id)) {
			error = `Model "${id}" is already configured.`;
			return;
		}
		drafts = [...drafts, { id, name: id, contextWindow: "", maxTokens: "", reasoning: false, imageInput: false }];
		manualId = "";
		error = null;
	}
	function patchDraft(id: string, patch: Partial<ModelDraft>) {
		drafts = drafts.map((d) => (d.id === id ? { ...d, ...patch } : d));
	}

	async function fetchModels() {
		if (busy) return;
		busy = "fetch";
		error = null;
		notice = null;
		const res = await fetch("/api/custom-endpoint/models", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ baseUrl, ...(apiKey.trim() ? { apiKey } : {}) }),
		}).catch(() => null);
		busy = null;
		if (!res) {
			error = "Could not reach the server — try again.";
			return;
		}
		const body = (await res.json().catch(() => ({}))) as { models?: DiscoveredModel[]; error?: string };
		if (!res.ok) {
			error = body.error ?? `Model discovery failed (${res.status})`;
			return;
		}
		discovered = body.models ?? [];
		notice = discovered.length === 0 ? "The endpoint returned no models — add one manually below." : `${discovered.length} model(s) discovered. Select the ones to configure.`;
	}

	async function save() {
		if (busy) return;
		busy = "save";
		error = null;
		notice = null;
		const models = drafts.map((d) => ({
			id: d.id, name: d.name, contextWindow: Number(d.contextWindow), maxTokens: Number(d.maxTokens), reasoning: d.reasoning, imageInput: d.imageInput,
		}));
		const res = await fetch("/api/custom-endpoint", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ displayName, baseUrl, models, ...(apiKey.trim() ? { apiKey } : {}) }),
		}).catch(() => null);
		busy = null;
		if (!res) {
			error = "Could not reach the server — try again.";
			return;
		}
		const body = (await res.json().catch(() => ({}))) as EndpointState & { error?: string };
		if (!res.ok) {
			error = body.error ?? `Save failed (${res.status})`;
			return;
		}
		endpointState = body;
		apiKey = "";
		notice = "Custom endpoint saved.";
		notifySettingsSaved("models");
		notifySettingsSaved("keys");
	}

	async function remove() {
		if (busy) return;
		busy = "delete";
		error = null;
		notice = null;
		const res = await fetch("/api/custom-endpoint", { method: "DELETE" }).catch(() => null);
		busy = null;
		if (!res || !res.ok) {
			error = "Could not remove the endpoint — try again.";
			return;
		}
		endpointState = (await res.json()) as EndpointState;
		onOpenChange(false);
		notifySettingsSaved("models");
		notifySettingsSaved("keys");
	}

	const envOwnedKey = $derived(endpointState?.keySource === "env");
	const configured = $derived(endpointState?.endpoint ?? null);
	const status = $derived(
		!configured ? "not configured" : !endpointState?.keyPresent ? "key missing" : configured.models.length === 1 ? "1 model" : `${configured.models.length} models`,
	);
</script>

<div data-testid="custom-endpoint">
	<button type="button" aria-expanded={open} data-testid="custom-endpoint-row" onclick={() => onOpenChange(!open)} class="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left transition-colors hover:bg-accent/50">
		<span class="font-ui text-xs text-foreground">{configured?.displayName ?? "Custom endpoint"}</span>
		<span data-testid="custom-endpoint-status" class="font-mono text-[11px] text-muted-foreground">{status}</span>
	</button>
	{#if open}
		<div data-testid="custom-endpoint-form" class="mt-1 flex flex-col gap-2 px-1 pb-2">
			<div class="flex items-center gap-2">
				<label for="custom-endpoint-display-name" class="w-28 shrink-0 font-ui text-xs text-muted-foreground">Display name</label>
				<input id="custom-endpoint-display-name" data-testid="custom-endpoint-display-name" value={displayName} oninput={(e) => (displayName = (e.currentTarget as HTMLInputElement).value)} placeholder="My endpoint" disabled={busy !== null} class="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50" />
			</div>
			<div class="flex items-center gap-2">
				<label for="custom-endpoint-base-url" class="w-28 shrink-0 font-ui text-xs text-muted-foreground">Base URL</label>
				<input id="custom-endpoint-base-url" data-testid="custom-endpoint-base-url" value={baseUrl} oninput={(e) => (baseUrl = (e.currentTarget as HTMLInputElement).value)} placeholder="https://host/v1" disabled={busy !== null} spellcheck={false} class="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50" />
			</div>
			<div class="flex items-center gap-2">
				<label for="custom-endpoint-api-key" class="w-28 shrink-0 font-ui text-xs text-muted-foreground">API key</label>
				<input id="custom-endpoint-api-key" data-testid="custom-endpoint-api-key" type="password" value={envOwnedKey ? "" : apiKey} oninput={(e) => (apiKey = (e.currentTarget as HTMLInputElement).value)} placeholder={envOwnedKey ? "From environment (read-only)" : endpointState?.keyPresent ? "Saved — leave blank to keep" : "Paste key…"} autocomplete="off" disabled={busy !== null || envOwnedKey} class="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50 disabled:opacity-60" />
			</div>
			{#if envOwnedKey}
				<p data-testid="custom-endpoint-env-key" class="pl-[7.5rem] text-[11px] text-muted-foreground">LH_CUSTOM_ENDPOINT_API_KEY owns this key. Unset it to edit the key or change the base URL.</p>
			{/if}
			<div class="flex flex-wrap items-center gap-3 pt-1">
				<button type="button" data-testid="custom-endpoint-fetch" onclick={() => void fetchModels()} disabled={busy !== null || !baseUrl.trim()} class="text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline">{busy === "fetch" ? "Fetching…" : "Fetch models"}</button>
				<button type="button" data-testid="custom-endpoint-save" onclick={() => void save()} disabled={busy !== null} class="text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline">{busy === "save" ? "Saving…" : "Save"}</button>
				{#if configured}
					<button type="button" data-testid="custom-endpoint-delete" onclick={() => void remove()} disabled={busy !== null} class="ml-auto text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline disabled:text-muted-foreground/40 disabled:no-underline">Remove endpoint</button>
				{/if}
			</div>
			{#if error}<p role="alert" data-testid="custom-endpoint-error" class="text-xs text-red-500">{error}</p>{/if}
			{#if notice}<p data-testid="custom-endpoint-notice" class="text-xs text-muted-foreground">{notice}</p>{/if}

			{#if drafts.length > 0}
				<div data-testid="custom-endpoint-models" class="mt-1 flex flex-col gap-2 border-t border-border/60 pt-2">
					<p class="text-[10px] uppercase tracking-widest text-muted-foreground">Configured models</p>
					{#each drafts as draft (draft.id)}
						{@const safe = safeId(draft.id)}
						<div data-testid={`custom-endpoint-model-${safe}`} class="flex flex-col gap-1.5 rounded-sm border border-border/60 p-2">
							<div class="flex items-center justify-between gap-2">
								<span class="min-w-0 truncate font-mono text-xs text-foreground">{draft.id}</span>
								<button type="button" data-testid={`custom-endpoint-model-${safe}-remove`} onclick={() => removeDraft(draft.id)} disabled={busy !== null} class="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline">Remove</button>
							</div>
							<div class="flex flex-wrap items-center gap-3">
								<label class="flex items-center gap-1.5 font-ui text-xs text-muted-foreground">Context tokens
									<input type="number" min={1} data-testid={`custom-endpoint-model-${safe}-context`} value={draft.contextWindow} oninput={(e) => patchDraft(draft.id, { contextWindow: (e.currentTarget as HTMLInputElement).value })} disabled={busy !== null} class="h-7 w-28 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none" />
								</label>
								<label class="flex items-center gap-1.5 font-ui text-xs text-muted-foreground">Max output
									<input type="number" min={1} data-testid={`custom-endpoint-model-${safe}-max`} value={draft.maxTokens} oninput={(e) => patchDraft(draft.id, { maxTokens: (e.currentTarget as HTMLInputElement).value })} disabled={busy !== null} class="h-7 w-28 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none" />
								</label>
								<label class="flex items-center gap-1.5 font-ui text-xs text-muted-foreground"><input type="checkbox" data-testid={`custom-endpoint-model-${safe}-reasoning`} checked={draft.reasoning} onchange={(e) => patchDraft(draft.id, { reasoning: (e.currentTarget as HTMLInputElement).checked })} disabled={busy !== null} />Reasoning</label>
								<label class="flex items-center gap-1.5 font-ui text-xs text-muted-foreground"><input type="checkbox" data-testid={`custom-endpoint-model-${safe}-image`} checked={draft.imageInput} onchange={(e) => patchDraft(draft.id, { imageInput: (e.currentTarget as HTMLInputElement).checked })} disabled={busy !== null} />Image input</label>
							</div>
						</div>
					{/each}
				</div>
			{/if}

			{#if discovered.length > 0}
				<div data-testid="custom-endpoint-discovered" class="mt-1 flex flex-col gap-1 border-t border-border/60 pt-2">
					<p class="text-[10px] uppercase tracking-widest text-muted-foreground">Discovered models</p>
					<div class="flex max-h-40 flex-col overflow-y-auto">
						{#each discovered as model (model.id)}
							{@const selected = drafts.some((d) => d.id === model.id)}
							<label class="flex items-center gap-2 rounded-sm px-1 py-1 font-ui text-xs text-foreground hover:bg-accent/40">
								<input type="checkbox" data-testid={`custom-endpoint-discovered-${safeId(model.id)}`} checked={selected} onchange={() => (selected ? removeDraft(model.id) : addDiscovered(model))} disabled={busy !== null} />
								<span class="min-w-0 truncate">{model.name}</span>
								{#if model.name !== model.id}<span class="ml-auto min-w-0 truncate font-mono text-[10px] text-muted-foreground">{model.id}</span>{/if}
							</label>
						{/each}
					</div>
				</div>
			{/if}

			<div class="mt-1 flex items-center gap-2 border-t border-border/60 pt-2">
				<label for="custom-endpoint-manual-id" class="shrink-0 font-ui text-xs text-muted-foreground">Add model</label>
				<input id="custom-endpoint-manual-id" data-testid="custom-endpoint-manual-id" value={manualId} oninput={(e) => (manualId = (e.currentTarget as HTMLInputElement).value)} onkeydown={(e) => { if (e.key === "Enter") addManual(); }} placeholder="model-id" disabled={busy !== null} class="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50" />
				<button type="button" data-testid="custom-endpoint-manual-add" onclick={addManual} disabled={busy !== null || !manualId.trim()} class="shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline">Add</button>
			</div>
		</div>
	{/if}
</div>
