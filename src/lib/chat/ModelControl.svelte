<script lang="ts">
	import { getContext } from "svelte";
	import { hint } from "$lib/hint";
	import { formatUsd, prettyModel } from "$lib/format";
	import MenuShell from "$lib/ui/MenuShell.svelte";
	import ModelMenuList from "$lib/settings/ModelMenuList.svelte";
	import ThinkingMenuList from "$lib/settings/ThinkingMenuList.svelte";
	import { catalogLimits, modelCatalog } from "$lib/state/model-catalog.svelte";
	import { emitAppEvent, onKeyAction } from "$lib/events";
	import { settings as userSettings } from "$lib/state/settings.svelte";
	import { fetchChat, saveChatSettings } from "$lib/api/chats";
	import { saveSettingsSection } from "$lib/api/settings";
	import { ApiError } from "$lib/api/http";
	import { composeSlotModel, defaultOrderLevel, populateLevel, THINKING_LABEL } from "$lib/settings/compose";
	import type { ChatSettings } from "@/src/session/model";
	import type { ModelCatalogEntry, ModelsSettings, ModelSlotName } from "@/src/settings/model";
	import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";

	let { chatId }: { chatId?: string } = $props();

	const models = $derived(userSettings.record?.models);
	let session = $state<ChatSettings | undefined>(undefined);
	let open = $state<"model" | "thinking" | null>(null);
	let error = $state<string | null>(null);
	let container = $state<HTMLDivElement | null>(null);

	$effect(() => {
		if (!chatId) return;
		const id = chatId;
		fetchChat(id)
			.then((record) => (session = record.settings))
			.catch((err) => console.error(`[chat ${id}] model settings load failed:`, err));
	});

	const strong = $derived(models?.strong);
	const override = $derived<ChatSettings | undefined>(
		chatId
			? { model: session?.model ?? strong?.model, thinkingLevel: session?.thinkingLevel ?? strong?.thinkingLevel }
			: strong,
	);
	const effectiveId = $derived(override?.model?.id);
	const effectiveProvider = $derived(override?.model?.provider);
	const storedLevel = $derived(override?.thinkingLevel);
	const entry = $derived(modelCatalog.value?.models.find((m) => m.id === effectiveId && m.provider === effectiveProvider));
	const levels = $derived(entry?.supportedLevels ?? []);
	const effectiveLevel = $derived(storedLevel ?? (entry ? defaultOrderLevel(levels) : undefined));

	$effect(() => {
		if (open === null || typeof document === "undefined") return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (container && !container.contains(target)) open = null;
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			open = null;
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	});

	/** A refused write shows the server's reason; anything else is the network. */
	function showFailure(err: unknown) {
		error = err instanceof ApiError ? err.message : "Could not reach the server — try again.";
	}

	async function save(next: ModelsSettings) {
		setError(null);
		try {
			userSettings.set(await saveSettingsSection("models", next));
			open = null;
			emitAppEvent("settings-saved", { section: "models" });
		} catch (err) {
			showFailure(err);
		}
	}

	async function saveChat(next: ChatSettings) {
		if (!chatId) return;
		setError(null);
		try {
			session = (await saveChatSettings(chatId, next)).settings;
			open = null;
		} catch (err) {
			showFailure(err);
		}
	}

	function apply(provider: string, id: string, level: ThinkingLevel | undefined) {
		if (chatId) void saveChat({ model: { provider, id }, thinkingLevel: level });
		else void save(composeSlotModel(models, "strong", provider, id, level ?? ""));
	}

	function pickModel(model: ModelCatalogEntry) {
		apply(model.provider, model.id, populateLevel(storedLevel, model.supportedLevels));
	}

	function setError(value: string | null) {
		error = value;
	}

	$effect(() => {
		const onOpenPicker = () => {
			open = "model";
			error = null;
			modelCatalog.refresh();
		};
		const onCycleThinking = () => {
			if (levels.length === 0) return;
			const idx = effectiveLevel === undefined ? -1 : levels.indexOf(effectiveLevel);
			const next = levels[(idx + 1) % levels.length];
			if (next !== undefined) apply(effectiveProvider ?? "", effectiveId ?? "", next);
		};
		const offs = [onKeyAction("open-model-picker", onOpenPicker), onKeyAction("cycle-thinking", onCycleThinking)];
		return () => {
			for (const off of offs) off();
		};
	});

	function openMenu(kind: "model" | "thinking") {
		open = open === kind ? null : kind;
		error = null;
		if (kind === "model") modelCatalog.refresh();
	}
</script>

<div bind:this={container} class="relative flex items-center gap-1.5" data-testid="model-control">
	<button
		type="button"
		data-testid="stats-model"
		onclick={() => openMenu("model")}
		aria-expanded={open === "model"}
		{@attach hint("Model selector", { action: "open-model-picker", side: "bottom" })}
		class="flex items-center gap-1.5 rounded-full border bg-card/85 px-2.5 py-1 shadow-lg backdrop-blur transition-colors hover:border-border hover:bg-muted"
	>
		<span class="text-card-foreground">{effectiveId ? prettyModel(effectiveId) : "—"}</span>
		<span aria-hidden="true" class="text-xs text-muted-foreground">▾</span>
	</button>
	<button
		type="button"
		data-testid="stats-thinking"
		onclick={() => {
			if (entry === undefined) return;
			openMenu("thinking");
		}}
		aria-expanded={open === "thinking"}
		{@attach hint("Thinking", { action: "cycle-thinking", side: "bottom" })}
		class="flex items-center gap-1.5 rounded-full border bg-card/85 px-2.5 py-1 shadow-lg backdrop-blur transition-colors hover:border-border hover:bg-muted"
	>
		<span class="text-card-foreground">{effectiveLevel === undefined ? "—" : (THINKING_LABEL[effectiveLevel] ?? effectiveLevel)}</span>
		<span aria-hidden="true" class="text-xs text-muted-foreground">▾</span>
	</button>

	{#if open === "model"}
		<MenuShell anchor={container} testid="model-menu" preferredSide="up" menuClass="flex w-[22rem] flex-col rounded-xl border bg-card p-2 text-xs shadow-xl">
			{#if error}<div class="mb-1.5 text-destructive">{error}</div>{/if}
			<ModelMenuList
				models={modelCatalog.value?.models}
				{effectiveId}
				{effectiveProvider}
				onPick={pickModel}
				footer={modelCatalog.value && modelCatalog.value.models.length === 0
					? "No models — add a provider key in Keys"
					: chatId
						? "This session's model"
						: "Strong tier — the default for new sessions"}
			/>
		</MenuShell>
	{/if}
	{#if open === "thinking"}
		<MenuShell anchor={container} testid="thinking-menu" preferredSide="up" menuClass="flex w-44 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl">
			<ThinkingMenuList
				levels={modelCatalog.value ? levels : []}
				{effectiveLevel}
				onPick={(level) => apply(effectiveProvider ?? "", effectiveId ?? "", level as ThinkingLevel)}
				empty={modelCatalog.value ? (effectiveId ? `${prettyModel(effectiveId)} has no thinking levels.` : "Pick a model first.") : "Loading…"}
				footer="Levels this model actually supports"
			/>
			{#if error}<div class="mt-1 text-destructive">{error}</div>{/if}
		</MenuShell>
	{/if}
</div>
