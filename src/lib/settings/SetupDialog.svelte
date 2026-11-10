<script lang="ts">
	import { dismissLayer, modalLayer } from "$lib/ui/layer";
	import { ApiError, failureMessage } from "$lib/api/http";
	import { settings as userSettings } from "$lib/state/settings.svelte";
	import { keys, saveKey as storeKey } from "$lib/state/keys.svelte";
	import { modelCatalog } from "$lib/state/model-catalog.svelte";
	import type { AuthProviderInfo, ModelCatalogEntry, ModelSlotName, ModelsSettings } from "@/src/settings/model";
	import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
	import { prettyModel } from "$lib/format";
	import { hint } from "$lib/hint";
	import MenuShell from "$lib/ui/MenuShell.svelte";
	import ModelMenuList from "./ModelMenuList.svelte";
	import ThinkingMenuList from "./ThinkingMenuList.svelte";
	import ProviderMenuList from "./ProviderMenuList.svelte";
	import { populateLevel, thinkingLabel } from "./compose";
	import { prefillFromSlots, prefillLevelFromPin, setupStage, SLOT_META, SLOT_ORDER } from "./setup";
	import { focusOnMount } from "$lib/dom";

	let { open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (models: ModelsSettings) => void } = $props();

	const body = $derived(modelCatalog.value ?? null);
	const failed = $derived(modelCatalog.failed);
	const keyProviders = $derived(keys.value?.providers);
	let picked = $state<Partial<Record<ModelSlotName, ModelCatalogEntry>>>({});
	let levels = $state<Partial<Record<ModelSlotName, ThinkingLevel>>>({});
	let saving = $state(false);
	let error = $state<string | null>(null);
	let openMenu = $state<{ slot: ModelSlotName; kind: "model" | "thinking" } | null>(null);
	let keyProvider = $state<AuthProviderInfo | null>(null);
	let keyValue = $state("");
	let keySaving = $state(false);
	let keyError = $state<string | null>(null);
	let keyMenu = $state(false);
	let keyAnchor = $state<HTMLDivElement | null>(null);
	/** The pickers' trigger buttons, by `${kind}-${slot}`. */
	let triggers = $state<Record<string, HTMLButtonElement | null>>({});

	function stage(): "keys" | "pickers" {
		if (failed) return "keys";
		return setupStage(body ? body.providers : null);
	}

	$effect(() => {
		if (!open) return;
		error = null;
		void modelCatalog.refresh();
		void keys.refresh();
	});

	// Every catalog load while open (the open's refresh, a saved key)
	// re-prefills the pickers from the pinned slots.
	$effect(() => {
		if (!open) return;
		const value = modelCatalog.value;
		const pre = value ? prefillFromSlots(value.models, value.slots) : {};
		const preLevels: Partial<Record<ModelSlotName, ThinkingLevel>> = {};
		for (const slot of SLOT_ORDER) {
			const entry = pre[slot];
			if (entry) preLevels[slot] = prefillLevelFromPin(entry, value?.slots?.[slot]);
		}
		picked = pre;
		levels = preLevels;
	});

	$effect(() => {
		if (!keyMenu) return;
		return dismissLayer(() => (keyMenu = false), { inside: () => [keyAnchor], menus: true });
	});
	$effect(() => {
		if (openMenu === null) return;
		const trigger = triggers[`${openMenu.kind}-${openMenu.slot}`];
		return dismissLayer(() => (openMenu = null), { inside: () => [trigger], menus: true });
	});

	async function saveKey() {
		if (!keyProvider || !keyValue.trim() || keySaving) return;
		keySaving = true;
		keyError = null;
		try {
			await storeKey(keyProvider.envVar, keyValue);
		} catch (err) {
			keyError = failureMessage(err, "Save failed. Check your connection and try again.");
			return;
		} finally {
			keySaving = false;
		}
		keyProvider = null;
		keyValue = "";
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
		try {
			await userSettings.save("models", models);
		} catch (err) {
			saving = false;
			error = err instanceof ApiError ? `Save failed: ${err.message}` : "Save failed. Check your connection and try again.";
			return;
		}
		onDone(models);
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
		data-testid="setup-backdrop"
		{@attach modalLayer(onClose)}
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
									<button bind:this={triggers[`model-${slot}`]} type="button" aria-label={`${SLOT_META[slot].label} model`} data-testid={`setup-trigger-${slot}`} aria-expanded={openMenu?.slot === slot && openMenu.kind === "model"} onclick={() => (openMenu = openMenu?.slot === slot && openMenu.kind === "model" ? null : { slot, kind: "model" })} class="flex h-7 min-w-40 w-full items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50">
										<span class="min-w-0 flex-1 truncate">{entry ? prettyModel(entry.id) : "Pick a model…"}</span>
										<span aria-hidden="true" class="text-muted-foreground">▾</span>
									</button>
									{#if openMenu?.slot === slot && openMenu.kind === "model"}
										<MenuShell anchor={triggers[`model-${slot}`]} testid={`setup-menu-${slot}`} preferredSide="down" align="left" menuClass="flex w-[22rem] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl">
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
									<button bind:this={triggers[`thinking-${slot}`]} type="button" aria-label={`${SLOT_META[slot].label} thinking`} data-testid={`setup-thinking-${slot}`} aria-expanded={openMenu?.slot === slot && openMenu.kind === "thinking"} disabled={!entry} onclick={() => (openMenu = openMenu?.slot === slot && openMenu.kind === "thinking" ? null : { slot, kind: "thinking" })} class="flex h-7 w-24 items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-40">
										<span class="min-w-0 flex-1 truncate text-left">{entry ? (level ? thinkingLabel(level) : "…") : "—"}</span>
										<span aria-hidden="true" class="text-muted-foreground">▾</span>
									</button>
									{#if openMenu?.slot === slot && openMenu.kind === "thinking"}
										<MenuShell anchor={triggers[`thinking-${slot}`]} testid={`setup-thinking-menu-${slot}`} preferredSide="down" align="left" menuClass="flex w-44 flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl">
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
