<script lang="ts">
	import { Upload } from "@lucide/svelte";
	import { activity } from "$lib/state/activity.svelte";
	import { hint } from "$lib/hint";
	import { notesImportErrors, postNotesImport } from "./notes-import";

	let { onFinished }: { onFinished?: () => void } = $props();
	let input = $state<HTMLInputElement | null>(null);
	let errors = $state<string[]>([]);
	let importing = $state(false);
	let pending = false;


	async function submit(files: File[]) {
		if (pending || files.length === 0) return;
		pending = true;
		importing = true;
		errors = [];
		try {
			activity.refresh();
			errors = notesImportErrors(await postNotesImport(files));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors = files.map((file) => `${file.name}: ${message}`);
		} finally {
			pending = false;
			importing = false;
			onFinished?.();
			activity.refresh();
		}
	}
</script>

<input
	bind:this={input}
	type="file"
	multiple
	accept=".md,.markdown,.txt"
	class="hidden"
	onchange={(event) => {
		const files = (event.currentTarget as HTMLInputElement).files;
		if (files) void submit(Array.from(files));
		(event.currentTarget as HTMLInputElement).value = "";
	}}
/>
<button
	type="button"
	disabled={importing}
	onclick={() => input?.click()}
	data-testid="import-notes"
	{@attach hint("Import notes into the graph", { side: "bottom" })}
	class="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
>
	<Upload class="size-3" />
	{importing ? "Importing…" : "Import notes…"}
</button>
{#each errors as error, i (i)}
	<p role="alert" class="max-w-full whitespace-pre-wrap break-words text-xs text-red-400">{error}</p>
{/each}
