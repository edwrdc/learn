<script lang="ts">
	import type { ModelCatalogEntry, ModelSlotName, ModelsSettings } from "@/src/core";
	import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
	import { prettyModel } from "$lib/format";
	import { backdropDismiss } from "$lib/backdrop";
	import { hint } from "$lib/hint";
	import { notifySettingsSaved, watchSettings } from "$lib/state/settings-signal";
	import MenuShell from "$lib/ui/MenuShell.svelte";
	import ModelMenuList from "./ModelMenuList.svelte";
	import ThinkingMenuList from "./ThinkingMenuList.svelte";
	import ProviderMenuList from "./ProviderMenuList.svelte";
	import type { ProviderKeyInfo } from "./keys";
	import { defaultOrderLevel, populateLevel, THINKING_LABEL } from "./compose";
	import { prefillFromSlots, prefillLevelFromPin, setupStage, SLOT_ORDER } from "./setup";
	import { focusOnMount } from "$lib/dom";

	const SLOT_META: Record<ModelSlotName, { label: string; roster: string }> = {
		strong: { label: "Strong", roster: "Prober, teacher" },
		cheap: { label: "Cheap", roster: "Researcher, demo builder, extractor, auditor" },
		vision: { label: "Vision", roster: "Visual maker + PDF reader" },
	};
	interface ModelsBody {
		models: ModelCatalogEntry[];
		providers: Array<{ id: string; keyPresent: boolean }>;
		slots?: Record<ModelSlotName, { model: { provider: string; id: string }; thinkingLevel?: ThinkingLevel } | null>;
	}

	let { open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (models: ModelsSettings) => void } = $props();

	let body = $state<ModelsBody | null>(null);
	let failed = $state(false);
	let picked = $state<Partial<Record<ModelSlotName, ModelCatalogEntry>>>({});
	let levels = $state<Partial<Record<ModelSlotName, ThinkingLevel>>>({});
	let saving = $state(false);
	let error = $state<string | null>(null);
	let openMenu = $state<{ slot: ModelSlotName; kind: "model" | "thinking" } | null>(null);
	let keyProviders = $state<ProviderKeyInfo[] | undefined>(undefined);
	let keyProvider = $state<ProviderKeyInfo | null>(null);
	let keyValue = $state("");
	let keySaving = $state(false);
	let keyError = $state<string | null>(null);
	let keyMenu = $state(false);
	let keysTick = $state(0);
	let keyAnchor = $state<HTMLDivElement | null>(null);

	function stage(): "keys" | "pickers" {
		if (failed) return "keys";
		return setupStage(body ? body.providers : null);
	}

	$effect(() => watchSettings((section) => {
		if (section === "keys") keysTick += 1;
	}));

	$effect(() => {
		if (!open) return;
		void keysTick;
		picked = {};
		levels = {};
		error = null;
		fetch("/api/keys")
			.then((r) => r.json())
			.then((value: { providers?: ProviderKeyInfo[] }) => (keyProviders = value.providers ?? []))
			.catch(() => (keyProviders = []));
		fetch("/api/models")
			.then((r) => r.json())
			.then((value: ModelsBody) => {
				body = value;
				failed = false;
				const pre = prefillFromSlots(value.models, value.slots);
				picked = pre;
				const preLevels: Partial<Record<ModelSlotName, ThinkingLevel>> = {};
				for (const slot of SLOT_ORDER) {
					const entry = pre[slot];
					if (entry) preLevels[slot] = prefillLevelFromPin(entry, value.slots?.[slot]);
				}
				levels = preLevels;
			})
			.catch(() => (failed = true));
	});

	$effect(() => {
		if (!open || typeof document === "undefined") return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			if (keyMenu) {
				keyMenu = false;
				return;
			}
			if (openMenu !== null) openMenu = null;
			else onClose();
		};
		const onPointerDown = (event: PointerEvent) => {
			if (!(event.target instanceof Element)) return;
			const target = event.target;
			if (keyMenu) {
				if (target.closest("[data-lh-menu]") || target.closest('[data-testid="setup-key-provider"]')) return;
				keyMenu = false;
			}
			if (openMenu === null) return;
			const testid = openMenu.kind === "model" ? `setup-trigger-${openMenu.slot}` : `setup-thinking-${openMenu.slot}`;
			if (target.closest("[data-lh-menu]") || target.closest(`[data-testid="${testid}"]`)) return;
			openMenu = null;
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onPointerDown);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onPointerDown);
		};
	});

	async function saveKey() {
		if (!keyProvider || !keyValue.trim() || keySaving) return;
		keySaving = true;
		keyError = null;
		const res = await fetch(`/api/keys/${encodeURIComponent(keyProvider.envVar)}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ value: keyValue }),
		}).catch(() => null);
		keySaving = false;
		if (!res || !res.ok) {
			const detail = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
			keyError = res ? (detail?.error ?? `Save failed (${res.status})`) : "Save failed. Check your connection and try again.";
			return;
		}
		keyProvider = null;
		keyValue = "";
		notifySettingsSaved("keys");
	}

	async function save() {
		if (!SLOT_ORDER.every((slot) => picked[slot]) || saving) return;
		saving = true;
		error = null;
		const models: ModelsSettings = {};
		for (const slot of SLOT_ORDER) {
			const level = levels[slot];
			models[slot] = {
				model: { provider: picked[slot]!.provider, id: picked[slot]!.id },
				...(level ? { thinkingLevel: level } : {}),
			};
		}
		const res = await fetch("/api/settings/models", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(models),
		}).catch(() => null);
		if (!res || !res.ok) {
			saving = false;
			error = res ? `Save failed: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status}` : "Save failed. Check your connection and try again.";
			return;
		}
		notifySettingsSaved("models");
		onDone(models);
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
		data-testid="setup-backdrop"
		{@attach backdropDismiss(onClose)}
	>
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Set up your models"
			data-testid="setup-dialog"
			tabindex={-1}
			class="settings-dialog-pop flex max-h-[85vh] w-[640px] max-w-[90vw] flex-col overflow-hidden rounded-md border border-border bg-card shadow-xl"
		>
			<header class="flex h-15 shrink-0 items-center gap-3 border-b border-border px-5">
				<h2 class="font-title text-2xl tracking-tight">Set up your models</h2>
				<button type="button" aria-label="Close setup" data-testid="setup-close" onclick={onClose} {@attach hint("Close", { binding: "escape", side: "left" })} class="ml-auto text-muted-foreground transition-colors hover:text-foreground">✕</button>
			</header>

			{#if stage() === "keys"}
				<div class="flex flex-col px-6 py-5">
					{#if failed}
						<p class="text-sm text-foreground">Model catalog could not be loaded. Check the connection and retry.</p>
					{:else}
						<div class="flex flex-col gap-3 px-6 py-5" data-testid="setup-stage-keys">
							<p class="text-sm text-foreground">Add a provider key.</p>
							<p class="text-xs text-muted-foreground">Choose your AI provider and paste its API key. You’ll pick your models next.</p>
							<div class="flex flex-col gap-2">
								<div bind:this={keyAnchor} class="relative max-w-96">
									<button
										type="button"
										aria-label="Provider"
										data-testid="setup-key-provider"
										aria-expanded={keyMenu}
										onclick={() => (keyMenu = !keyMenu)}
										class="flex h-7 w-full items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50"
									>
										<span class="min-w-0 flex-1 truncate text-left">{keyProvider ? keyProvider.label : "Pick a provider…"}</span>
										<span aria-hidden="true" class="text-muted-foreground">▾</span>
									</button>
									{#if keyMenu}
										<MenuShell anchor={keyAnchor} testid="setup-key-provider-menu" preferredSide="down" align="left" menuClass="flex w-[22rem] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl">
											<ProviderMenuList providers={keyProviders ?? []} onPick={(provider) => { keyProvider = provider; keyMenu = false; keyError = null; }} />
										</MenuShell>
									{/if}
								</div>
								{#if keyProvider}
									<div class="flex max-w-96 items-center gap-2">
										<input type="text" value={keyValue} oninput={(event) => (keyValue = (event.currentTarget as HTMLInputElement).value)} onkeydown={(event) => { if (event.key === "Enter" && keyValue.trim()) void saveKey(); }} placeholder="Paste key…" aria-label={`${keyProvider.label} key`} data-testid="setup-key-input" disabled={keySaving} {@attach focusOnMount()} class="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50" />
										<button type="button" onclick={() => void saveKey()} disabled={keySaving || !keyValue.trim()} data-testid="setup-key-save" class="shrink-0 rounded-sm border border-border bg-background px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-40">{keySaving ? "Saving…" : "Save key"}</button>
									</div>
								{/if}
								{#if keyError}<p role="alert" data-testid="setup-key-error" class="text-xs text-red-400">{keyError}</p>{/if}
							</div>
						</div>
					{/if}
				</div>
			{:else}
				<div class="flex flex-col gap-4 overflow-y-auto px-6 py-5" data-testid="setup-stage-pickers">
					<p class="text-xs text-muted-foreground">Pick the model for each tier. All three are required before chats can start.</p>
					{#each SLOT_ORDER as slot (slot)}
						{@const entry = picked[slot]}
						{@const level = levels[slot]}
						{@const levelsForEntry = entry?.supportedLevels ?? []}
						{@const catalog = slot === "vision" ? body?.models.filter((model) => model.input.includes("image")) : body?.models}
						<div data-testid={`setup-slot-${slot}`} class="flex flex-col gap-1.5">
							<span class="flex items-center gap-1.5">
								<span class="font-ui text-sm text-foreground">{SLOT_META[slot].label}</span>
								{#if !body?.slots?.[slot]?.model && !picked[slot]}
									<span data-testid={`setup-needed-${slot}`} class="rounded-sm border border-border px-1 py-0.5 text-[10px] font-normal tracking-wide text-muted-foreground">needed</span>
								{/if}
							</span>
							<span class="text-xs text-muted-foreground/70">{SLOT_META[slot].roster}</span>
							<div class="flex items-center gap-2">
								<div class="relative flex-1">
									<button type="button" aria-label={`${SLOT_META[slot].label} model`} data-testid={`setup-trigger-${slot}`} aria-expanded={openMenu?.slot === slot && openMenu.kind === "model"} onclick={() => (openMenu = openMenu?.slot === slot && openMenu.kind === "model" ? null : { slot, kind: "model" })} class="flex h-7 min-w-40 w-full items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50">
										<span class="min-w-0 flex-1 truncate">{entry ? prettyModel(entry.id) : "Pick a model…"}</span>
										<span aria-hidden="true" class="text-muted-foreground">▾</span>
									</button>
									{#if openMenu?.slot === slot && openMenu.kind === "model"}
										<MenuShell anchorTestid={`setup-trigger-${slot}`} testid={`setup-menu-${slot}`} preferredSide="down" align="left" menuClass="flex w-[22rem] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl">
											<ModelMenuList
												models={catalog}
												effectiveId={entry?.id}
												effectiveProvider={entry?.provider}
												onPick={(model) => {
													picked = { ...picked, [slot]: model };
													levels = { ...levels, [slot]: populateLevel(levels[slot], model.supportedLevels) };
													openMenu = null;
												}}
												footer={catalog && catalog.length === 0 ? "No image-capable models. Add a provider key with access to a vision model." : undefined}
											/>
										</MenuShell>
									{/if}
								</div>
								<div class="relative">
									<button type="button" aria-label={`${SLOT_META[slot].label} thinking`} data-testid={`setup-thinking-${slot}`} aria-expanded={openMenu?.slot === slot && openMenu.kind === "thinking"} disabled={!entry} onclick={() => (openMenu = openMenu?.slot === slot && openMenu.kind === "thinking" ? null : { slot, kind: "thinking" })} class="flex h-7 w-24 items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-40">
										<span class="min-w-0 flex-1 truncate text-left">{entry ? (level ? THINKING_LABEL[level] ?? level : "…") : "—"}</span>
										<span aria-hidden="true" class="text-muted-foreground">▾</span>
									</button>
									{#if openMenu?.slot === slot && openMenu.kind === "thinking"}
										<MenuShell anchorTestid={`setup-thinking-${slot}`} testid={`setup-thinking-menu-${slot}`} preferredSide="down" align="left" menuClass="flex w-44 flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl">
											<ThinkingMenuList levels={levelsForEntry.map(String)} effectiveLevel={level} onPick={(value) => { levels = { ...levels, [slot]: value as ThinkingLevel }; openMenu = null; }} />
										</MenuShell>
									{/if}
								</div>
							</div>
						</div>
					{/each}
					<div class="flex items-center gap-3">
						<button type="button" data-testid="setup-save" disabled={!SLOT_ORDER.every((slot) => picked[slot]) || saving} onclick={() => void save()} class="rounded-sm border border-border bg-background px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-40">{saving ? "Saving…" : "Save models"}</button>
						{#if error}<p class="text-xs text-red-400">{error}</p>{/if}
					</div>
				</div>
			{/if}
		</div>
	</div>
{/if}
