<script lang="ts">
	import { FACTORY_SETTINGS, type GraphSettings } from "@/src/core";
	import Controls from "./Controls.svelte";
	import CommitInput from "./CommitInput.svelte";
	import Toggle from "$lib/ui/Toggle.svelte";

	let { graph, onSectionChange }: { graph: GraphSettings | undefined; onSectionChange: (next: GraphSettings) => void } = $props();
	const factoryTokens = FACTORY_SETTINGS.graph.extractionChunkTokens;
	const chunkTokens = $derived(graph?.extractionChunkTokens ?? factoryTokens);
</script>

<Controls kind="section" title="Graph" testid="section-graph">
	<Controls kind="row" label="Extraction" hint="Off = the graph stops growing" testid="graph-row-enabled">
		<Toggle checked={graph?.enabled ?? true} label="extraction enabled" onChange={(on) => onSectionChange({ ...graph, enabled: on })} />
	</Controls>
	<Controls kind="row" label="Graph rendering" hint="Off = home shows the chains view" testid="graph-row-rendering">
		<Toggle checked={graph?.rendering ?? true} label="graph rendering enabled" onChange={(on) => onSectionChange({ ...graph, rendering: on })} />
	</Controls>
	<Controls kind="row" label="Extraction chunk budget" hint={`${chunkTokens} tok`} testid="graph-row-chunk-tokens">
		<CommitInput
			type="number"
			value={String(graph?.extractionChunkTokens ?? "")}
			placeholder={String(factoryTokens)}
			ariaLabel="extraction chunk budget"
			testid="input-chunk-tokens"
			onCommit={(value) => {
				if (value === "") return onSectionChange({ ...graph, extractionChunkTokens: undefined });
				const n = Number(value);
				if (Number.isFinite(n) && n > 0) onSectionChange({ ...graph, extractionChunkTokens: Math.max(1024, Math.round(n)) });
			}}
		/>
	</Controls>
</Controls>
