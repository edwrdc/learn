<script lang="ts">
	import type { AppearanceSettings } from "@/src/core";
	import { appearance } from "$lib/state/appearance.svelte";
	import { hint } from "$lib/hint";
	import MenuShell from "$lib/ui/MenuShell.svelte";
	import Controls from "./Controls.svelte";
	import CommitInput from "./CommitInput.svelte";
	import ThinSelect from "./ThinSelect.svelte";
	import Toggle from "$lib/ui/Toggle.svelte";
	import FontMenuList from "./FontMenuList.svelte";
	import { composeFontFamily, CURATED_FALLBACK_FONTS, DEFAULT_READING_FONT } from "./fonts";

	let { appearance: delta, onSectionChange }: { appearance: AppearanceSettings | undefined; onSectionChange: (next: AppearanceSettings) => void } = $props();

	const resolved = $derived(appearance.resolved);

	let fontOpen = $state(false);
	let localFonts = $state<string[] | null | undefined>(undefined);
	let enumEmpty = $state(false);
	let anchor = $state<HTMLSpanElement | null>(null);

	function openFontMenu() {
		if (!fontOpen && localFonts === undefined) {
			const api = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts;
			if (!api) localFonts = null;
			else {
				void api()
					.then((fonts) => {
						const families = [...new Set(fonts.map((f) => f.family))].filter((f) => f !== DEFAULT_READING_FONT).sort((a, b) => a.localeCompare(b));
						if (families.length === 0) {
							localFonts = null;
							enumEmpty = true;
						} else localFonts = families;
					})
					.catch(() => (localFonts = null));
			}
		}
		fontOpen = !fontOpen;
	}

	function composeFont(family: string | null): AppearanceSettings {
		return composeFontFamily(delta, family);
	}

	$effect(() => {
		if (!fontOpen || typeof document === "undefined") return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (anchor?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (target instanceof Element && target.closest('[role="dialog"]')) fontOpen = false;
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			fontOpen = false;
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKey);
		};
	});
</script>

<Controls kind="row" label="Mode" hint="Coming soon" testid="row-mode" dimmed>
	<ThinSelect value="dark" ariaLabel="mode" onChange={() => {}} testid="select-mode" disabled>
		<option value="dark">Dark</option>
	</ThinSelect>
</Controls>
<Controls kind="row" label="Background" hint={`Empty = ${resolved.background ?? "#141414"}`} testid="row-background">
	<CommitInput value={delta?.background ?? ""} placeholder="#141414" ariaLabel="background hex" testid="input-background" onCommit={(value) => onSectionChange({ ...delta, background: value === "" ? null : value })} />
</Controls>
<Controls kind="row" label="Reading font" hint={`Empty = ${DEFAULT_READING_FONT}`} testid="row-font">
	<span bind:this={anchor} class="relative flex items-center gap-2">
		<button
			type="button"
			aria-label="Reading font"
			aria-expanded={fontOpen}
			data-testid="font-trigger"
			onclick={openFontMenu}
			{@attach hint("Choose from your installed fonts", { side: "left" })}
			class="flex h-7 min-w-20 items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50"
		>
			<span class="min-w-0 flex-1 truncate">{delta?.fontFamily || DEFAULT_READING_FONT}</span>
			<span aria-hidden="true" class="text-muted-foreground">▾</span>
		</button>
		{#if fontOpen}
			<MenuShell anchor={anchor} testid="font-menu" preferredSide="down" menuClass="flex w-[18rem] flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl">
				<FontMenuList
					families={localFonts === undefined ? undefined : (localFonts ?? CURATED_FALLBACK_FONTS)}
					effectiveFamily={delta?.fontFamily ?? null}
					onPick={(family) => {
						fontOpen = false;
						onSectionChange(composeFont(family));
					}}
					footer={localFonts === undefined ? undefined : localFonts === null ? (enumEmpty ? "Common families — installed fonts could not be read" : "Common families — your installed list needs the desktop app") : "Your installed fonts"}
				/>
			</MenuShell>
		{/if}
	</span>
</Controls>
<Controls kind="row" label="Reading font size" hint={`${resolved.proseFontSize}px`} testid="row-prose-size">
	<CommitInput
		type="number"
		value={String(delta?.proseFontSize ?? "")}
		placeholder="16"
		ariaLabel="prose font size"
		testid="input-prose-size"
		onCommit={(value) => {
			if (value === "") return onSectionChange({ ...delta, proseFontSize: undefined });
			const n = Number(value);
			if (Number.isFinite(n)) onSectionChange({ ...delta, proseFontSize: Math.min(24, Math.max(12, Math.round(n))) });
		}}
	/>
</Controls>
<Controls kind="row" label="Session names in serif" testid="row-session-serif">
	<Toggle checked={delta?.sessionNameSerif ?? true} label="session names serif" onChange={(on) => onSectionChange({ ...delta, sessionNameSerif: on })} />
</Controls>
<Controls kind="row" label="Heading weight" hint={`${resolved.mdRendering.headingWeight}`} testid="row-heading-weight">
	<CommitInput
		type="number"
		value={String(delta?.mdRendering?.headingWeight ?? "")}
		placeholder="900"
		ariaLabel="heading weight"
		testid="input-heading-weight"
		onCommit={(value) => {
			if (value === "") return onSectionChange({ ...delta, mdRendering: { ...delta?.mdRendering, headingWeight: undefined } });
			const n = Number(value);
			if (Number.isFinite(n)) onSectionChange({ ...delta, mdRendering: { ...delta?.mdRendering, headingWeight: Math.min(900, Math.max(100, Math.round(n))) } });
		}}
	/>
</Controls>
<Controls kind="row" label="Bold color" hint="Empty = same as text" testid="row-bold-color">
	<CommitInput value={delta?.mdRendering?.boldColor ?? ""} placeholder="same as text" ariaLabel="bold color" testid="input-bold-color" onCommit={(value) => onSectionChange({ ...delta, mdRendering: { ...delta?.mdRendering, boldColor: value === "" ? null : value } })} />
</Controls>
<Controls kind="row" label="Italic color" hint="Empty = same as text" testid="row-italic-color">
	<CommitInput value={delta?.mdRendering?.italicColor ?? ""} placeholder="same as text" ariaLabel="italic color" testid="input-italic-color" onCommit={(value) => onSectionChange({ ...delta, mdRendering: { ...delta?.mdRendering, italicColor: value === "" ? null : value } })} />
</Controls>
