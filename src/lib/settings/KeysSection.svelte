<script lang="ts">
	import { dismissLayer } from "$lib/ui/layer";
	import { deleteKey as removeKey, saveKey as putKey } from "$lib/api/settings";
	import { untrack } from "svelte";
	import type { AuthProviderInfo } from "@/src/settings/model";
	import { keys } from "$lib/state/keys.svelte";
	import { classifyKeys, keyStatusLine } from "./keys";
	import { emitAppEvent } from "$lib/events";
	import MenuShell from "$lib/ui/MenuShell.svelte";
	import Controls from "./Controls.svelte";
	import ProviderMenuList from "./ProviderMenuList.svelte";
	import CustomEndpointSection from "./CustomEndpointSection.svelte";
	import { focusOnMount } from "$lib/dom";



	let { initialRow }: { initialRow?: string } = $props();
	/** Null while loading; a failed first load shows no rows. */
	const statuses = $derived(keys.value?.keys ?? (keys.failed ? [] : null));
	const providers = $derived(keys.value?.providers);
	let openRow = $state<string | null>(untrack(() => initialRow ?? null));
	let adding = $state<AuthProviderInfo | null>(null);
	let addError = $state<string | null>(null);
	let addValue = $state("");
	let customOpen = $state(false);
	let addProviderOpen = $state(false);
	let addAnchor = $state<HTMLDivElement | null>(null);
	let rowValue = $state("");
	let rowError = $state<string | null>(null);
	let rowBusy = $state(false);

	$effect(() => {
		if (initialRow !== undefined) openRow = initialRow;
	});

	$effect(() => {
		void keys.refresh();
	});

	$effect(() => {
		if (openRow === null && adding === null) return;
		return dismissLayer(
			() => {
				openRow = null;
				adding = null;
			},
			{ clickOutside: false, capture: true },
		);
	});

	$effect(() => {
		if (!addProviderOpen) return;
		return dismissLayer(() => (addProviderOpen = false), { inside: () => [addAnchor], menus: true, closeWithin: '[role="dialog"]' });
	});

	async function saveKey(id: string, value: string): Promise<string | null> {
		try {
			await putKey(id, value);
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		await keys.refresh();
		emitAppEvent("settings-saved", { section: "keys" });
		return null;
	}

	async function deleteKey(id: string) {
		rowError = null;
		try {
			await removeKey(id);
		} catch (error) {
			rowError = error instanceof Error ? error.message : String(error);
			return;
		}
		await keys.refresh();
		emitAppEvent("settings-saved", { section: "keys" });
	}

	async function saveRow(id: string) {
		if (!rowValue.trim() || rowBusy) return;
		rowBusy = true;
		rowError = null;
		const error = await saveKey(id, rowValue);
		if (error) rowError = error;
		else {
			rowValue = "";
			openRow = null;
		}
		rowBusy = false;
	}

	async function saveNewProvider(provider: AuthProviderInfo) {
		if (!addValue.trim()) return;
		const error = await saveKey(provider.envVar, addValue);
		if (error) addError = error;
		else {
			adding = null;
			addValue = "";
			addError = null;
		}
	}

	const classified = $derived(statuses ? classifyKeys(statuses, providers) : null);
</script>

{#if statuses === null}
	<p class="px-6 py-5 text-xs text-muted-foreground/70">Loading keys…</p>
{:else if classified}
	<Controls kind="group" label="Model providers" testid="group-provider-keys">
		{#each classified.providerRows as status (status.id)}
			<div data-testid={`key-${status.id.toLowerCase()}`} class={status.source === "env" ? "opacity-40" : undefined}>
				{#if openRow === status.id && status.source !== "env"}
					<div class="flex items-center gap-2 rounded-sm px-1 py-1.5" data-testid={`key-${status.id.toLowerCase()}-editor`}>
						<span class="shrink-0 font-ui text-xs text-foreground">{providers?.find((p) => p.envVar === status.id)?.label ?? status.info?.label ?? status.id}</span>
						<input value={rowValue} oninput={(event) => (rowValue = (event.currentTarget as HTMLInputElement).value)} onkeydown={(event) => { if (event.key === "Enter") void saveRow(status.id); }} placeholder="Paste key…" aria-label={`${status.id} key`} data-testid={`key-${status.id.toLowerCase()}-input`} disabled={rowBusy} {@attach focusOnMount()} class="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50" />
						<button type="button" onclick={() => void saveRow(status.id)} disabled={rowBusy || !rowValue.trim()} data-testid={`key-${status.id.toLowerCase()}-save`} class="shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline">Save</button>
						<button type="button" onclick={() => (openRow = null)} disabled={rowBusy} data-testid={`key-${status.id.toLowerCase()}-cancel`} class="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline">Cancel</button>
						{#if status.present && status.source === "file"}
							<button type="button" onclick={() => void deleteKey(status.id)} disabled={rowBusy} data-testid={`key-${status.id.toLowerCase()}-delete`} class="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline">Delete</button>
						{/if}
					</div>
					{#if rowError}<p role="alert" data-testid={`key-${status.id.toLowerCase()}-error`} class="px-1 text-xs text-red-500">{rowError}</p>{/if}
				{:else}
					<button type="button" aria-expanded={openRow === status.id} data-testid={`key-${status.id.toLowerCase()}-row`} onclick={() => { if (status.source !== "env") { openRow = openRow === status.id ? null : status.id; rowValue = ""; rowError = null; } }} class="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left {status.source === 'env' ? 'cursor-default' : 'cursor-pointer transition-colors hover:bg-accent/50'}">
						<span class="font-ui text-xs text-foreground">{providers?.find((p) => p.envVar === status.id)?.label ?? status.info?.label ?? status.id}</span>
						<span class="flex items-center gap-2">
							{#if status.info?.docsUrl}
								<a href={status.info.docsUrl} target="_blank" rel="noreferrer" onclick={(event) => event.stopPropagation()} class="text-[10px] text-muted-foreground/60 underline-offset-2 hover:text-foreground hover:underline">key ↗</a>
							{/if}
							<span data-testid={`key-${status.id.toLowerCase()}-status`} class="font-mono text-[11px] text-muted-foreground">{keyStatusLine(status)}</span>
						</span>
					</button>
				{/if}
			</div>
		{/each}
		{#if providers !== undefined}
			<div bind:this={addAnchor} class="relative">
				<button type="button" aria-expanded={addProviderOpen} data-testid="add-provider" onclick={() => (addProviderOpen = !addProviderOpen)} class="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left font-ui text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground">
					<span>+ Add provider key</span>
					{#if classified.addable.length > 0}<span class="font-mono text-[11px]">{classified.addable.length}</span>{/if}
				</button>
				{#if addProviderOpen}
					<MenuShell anchor={addAnchor} testid="add-provider-menu" preferredSide="down" menuClass="flex w-72 flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl">
						<button type="button" data-testid="add-provider-custom" onclick={() => { addProviderOpen = false; adding = null; customOpen = true; }} class="mb-1 flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted">
							<span class="truncate text-card-foreground">Custom endpoint</span>
							<span class="shrink-0 font-mono text-[11px] text-muted-foreground">Responses</span>
						</button>
						<ProviderMenuList providers={classified.addable} onPick={(provider) => { addProviderOpen = false; adding = provider; addError = null; addValue = ""; }} />
					</MenuShell>
				{/if}
			</div>
			<CustomEndpointSection open={customOpen} onOpenChange={(value) => (customOpen = value)} />
			{#if adding}
				<div class="flex items-center gap-2 rounded-sm px-1 py-1.5" data-testid={`key-${adding.id}-editor`}>
					<span class="shrink-0 font-ui text-xs text-foreground">{adding.label}</span>
					<input type="text" value={addValue} oninput={(event) => (addValue = (event.currentTarget as HTMLInputElement).value)} onkeydown={(event) => { if (event.key === "Enter" && addValue.trim()) void saveNewProvider(adding!); }} placeholder="Paste key…" aria-label={`${adding.label} key`} data-testid={`key-${adding.id}-input`} {@attach focusOnMount()} class="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50" />
					<button type="button" onclick={() => void saveNewProvider(adding!)} disabled={!addValue.trim()} data-testid={`key-${adding.id}-save`} class="shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline">Save</button>
					<button type="button" onclick={() => (adding = null)} data-testid={`key-${adding.id}-cancel`} class="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline">Cancel</button>
					{#if addError}<p role="alert" class="w-full pl-0 text-xs text-red-500" data-testid={`key-${adding.id}-error`}>{addError}</p>{/if}
				</div>
			{/if}
		{/if}
	</Controls>

	<Controls kind="group" label="Tools & services" testid="group-tool-keys">
		{#each classified.toolRows as status (status.id)}
			<div data-testid={`key-${status.id.toLowerCase()}`} class={status.source === "env" ? "opacity-40" : undefined}>
				{#if openRow === status.id && status.source !== "env"}
					<div class="flex items-center gap-2 rounded-sm px-1 py-1.5" data-testid={`key-${status.id.toLowerCase()}-editor`}>
						<span class="shrink-0 font-ui text-xs text-foreground">{status.info?.label ?? status.id}</span>
						<input value={rowValue} oninput={(event) => (rowValue = (event.currentTarget as HTMLInputElement).value)} onkeydown={(event) => { if (event.key === "Enter") void saveRow(status.id); }} placeholder="Paste key…" aria-label={`${status.info?.label ?? status.id} key`} data-testid={`key-${status.id.toLowerCase()}-input`} disabled={rowBusy} {@attach focusOnMount()} class="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50" />
						<button type="button" onclick={() => void saveRow(status.id)} disabled={rowBusy || !rowValue.trim()} data-testid={`key-${status.id.toLowerCase()}-save`} class="shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline">Save</button>
						<button type="button" onclick={() => (openRow = null)} data-testid={`key-${status.id.toLowerCase()}-cancel`} class="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline">Cancel</button>
						{#if status.present && status.source === "file"}
							<button type="button" onclick={() => void deleteKey(status.id)} data-testid={`key-${status.id.toLowerCase()}-delete`} class="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline">Delete</button>
						{/if}
					</div>
					{#if rowError}<p role="alert" data-testid={`key-${status.id.toLowerCase()}-error`} class="px-1 text-xs text-red-500">{rowError}</p>{/if}
				{:else}
					<button type="button" aria-expanded={openRow === status.id} data-testid={`key-${status.id.toLowerCase()}-row`} onclick={() => { if (status.source !== "env") { openRow = openRow === status.id ? null : status.id; rowValue = ""; rowError = null; } }} class="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left {status.source === 'env' ? 'cursor-default' : 'cursor-pointer transition-colors hover:bg-accent/50'}">
						<span class="font-ui text-xs text-foreground">{status.info?.label ?? status.id}</span>
						<span class="flex items-center gap-2">
							{#if status.info?.docsUrl}
								<a href={status.info.docsUrl} target="_blank" rel="noreferrer" onclick={(event) => event.stopPropagation()} class="text-[10px] text-muted-foreground/60 underline-offset-2 hover:text-foreground hover:underline">key ↗</a>
							{/if}
							<span data-testid={`key-${status.id.toLowerCase()}-status`} class="font-mono text-[11px] text-muted-foreground">{keyStatusLine(status)}</span>
						</span>
					</button>
				{/if}
			</div>
		{/each}
	</Controls>

	{#if classified.unknownRows.length > 0}
		<Controls kind="group" label="Other stored variables" testid="group-unknown-keys">
			{#each classified.unknownRows as status (status.id)}
				<div data-testid={`unknown-${status.id}`} class="flex items-center justify-between gap-3 px-1 py-1.5 opacity-40">
					<span class="font-mono text-xs text-foreground">{status.id}</span>
					<span class="font-mono text-[11px] text-muted-foreground">{status.masked}</span>
				</div>
			{/each}
		</Controls>
	{/if}
{/if}
