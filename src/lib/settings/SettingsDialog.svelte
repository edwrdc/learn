<script lang="ts">
	import { dismissLayer } from "$lib/ui/layer";
	import { CURRENT_SETTINGS_VERSION } from "@/src/settings/model";
	import { backdropDismiss } from "$lib/backdrop";
	import { hint } from "$lib/hint";
	import { settingsDialog, type SettingsSectionId } from "$lib/state/dialogs.svelte";
	import { settings as userSettings } from "$lib/state/settings.svelte";
	import Controls from "./Controls.svelte";
	import KeysSection from "./KeysSection.svelte";
	import AgentSection from "./AgentSection.svelte";
	import AppearanceSection from "./AppearanceSection.svelte";
	import KeyboardSection from "./KeyboardSection.svelte";
	import GraphSection from "./GraphSection.svelte";

	const SECTIONS: Array<{ id: SettingsSectionId; label: string }> = [
		{ id: "keys", label: "Keys" },
		{ id: "agent", label: "Agent" },
		{ id: "appearance", label: "Appearance" },
		{ id: "graph", label: "Graph" },
		{ id: "keyboard", label: "Keyboard" },
	];

	/** Undefined while loading, null when the load failed. */
	const record = $derived(
		userSettings.record !== undefined
			? (userSettings.record ?? { version: CURRENT_SETTINGS_VERSION })
			: userSettings.failed
				? null
				: undefined,
	);
	let error = $state<string | null>(null);
	let active = $state<SettingsSectionId>("keys");

	$effect(() => {
		if (!settingsDialog.show) return;
		active = settingsDialog.section;
	});
	$effect(() => {
		if (settingsDialog.show) void userSettings.refresh();
	});
	$effect(() => {
		if (!settingsDialog.show) return;
		return dismissLayer(() => settingsDialog.close(), { clickOutside: false });
	});

	async function write(section: "agent" | "models" | "appearance" | "graph" | "compaction", body: object) {
		error = null;
		try {
			await userSettings.save(section, body);
		} catch (err) {
			error = `${section}: ${err instanceof Error ? err.message : String(err)}`;
		}
	}
</script>

{#if settingsDialog.show}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
		data-testid="settings-backdrop"
		{@attach backdropDismiss(() => settingsDialog.close())}
	>
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Settings"
			data-testid="settings-dialog"
			tabindex={-1}
			class="settings-dialog-pop flex h-[620px] max-h-[85vh] w-[920px] max-w-[90vw] flex-col overflow-hidden rounded-md border border-border bg-card shadow-xl"
		>
			<header class="flex h-15 shrink-0 items-center gap-3 border-b border-border px-5">
				<h2 class="font-title text-2xl tracking-tight">Settings</h2>
				<button
					type="button"
					aria-label="Close settings"
					data-testid="settings-close"
					{@attach hint("Close", { binding: "escape", side: "left" })}
					class="ml-auto size-7 rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					onclick={() => settingsDialog.close()}
				>
					<svg viewBox="0 0 16 16" class="mx-auto size-3.5" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8" /></svg>
				</button>
			</header>

			<div class="flex min-h-0 flex-1">
				<nav aria-label="Settings sections" data-testid="settings-nav" class="flex w-44 shrink-0 flex-col gap-1 border-r border-border p-2">
					{#each SECTIONS as section (section.id)}
						<button
							type="button"
							data-testid={`settings-nav-${section.id}`}
							aria-current={active === section.id}
							class="rounded-sm px-3 py-1.5 text-left font-ui text-sm transition-colors {active === section.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
							onclick={() => (active = section.id)}
						>{section.label}</button>
					{/each}
				</nav>

				<div class="min-w-0 flex-1 overflow-y-auto" data-testid="settings-content">
					{#if error}
						<p role="alert" class="m-4 rounded-sm border border-red-500/40 px-3 py-2 text-xs text-red-500" data-testid="settings-error">{error}</p>
					{/if}
					{#if record === undefined}
						<p class="px-6 py-5 text-xs text-muted-foreground/70">Loading settings…</p>
					{:else if record === null}
						<p class="px-6 py-5 text-xs text-muted-foreground/70">Settings could not be loaded — refresh to retry.</p>
					{:else}
						{#if active === "keys"}
							<Controls kind="section" title="Keys" testid="section-keys">
								<KeysSection initialRow={settingsDialog.row ?? undefined} />
							</Controls>
						{:else if active === "agent"}
							<Controls kind="section" title="Agent" testid="section-agent">
								<AgentSection
									agent={record.agent}
									models={record.models}
									graph={record.graph}
									compaction={record.compaction}
									onModelsChange={(next) => void write("models", next)}
									onSectionChange={(next) => void write("agent", next)}
									onCompactionChange={(next) => void write("compaction", next)}
								/>
							</Controls>
						{:else if active === "appearance"}
							<Controls kind="section" title="Appearance" testid="section-appearance">
								<AppearanceSection appearance={record.appearance} onSectionChange={(next) => void write("appearance", next)} />
							</Controls>
						{:else if active === "graph"}
							<GraphSection graph={record.graph} onSectionChange={(next) => void write("graph", next)} />
						{:else if active === "keyboard"}
							<Controls kind="section" title="Keyboard" hint="Stored on this device" testid="section-keyboard">
								<KeyboardSection />
							</Controls>
						{/if}
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}
