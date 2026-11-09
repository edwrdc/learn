<script lang="ts">
	import "katex/dist/katex.min.css";
	import "@fontsource-variable/jetbrains-mono";
	import "@fontsource-variable/source-sans-3";
	import "$lib/styles/globals.css";
	import { onMount, type Snippet } from "svelte";
	import Sidebar from "$lib/shell/Sidebar.svelte";
	import SettingsDialog from "$lib/settings/SettingsDialog.svelte";
	import CheatSheet from "$lib/shell/CheatSheet.svelte";
	import { serverEvents } from "$lib/state/server-events";
	import { sidebar } from "$lib/state/sidebar.svelte";
	import { appearance } from "$lib/state/appearance.svelte";
	import { initKeyboard } from "$lib/state/keyboard";

	let { children }: { children: Snippet } = $props();

	$effect(() => appearance.apply());

	onMount(() => {
		serverEvents.start();
		sidebar.init();
		const offKeyboard = initKeyboard();
		return () => {
			offKeyboard();
			serverEvents.stop();
		};
	});
</script>

<svelte:head>
	<title>Learning Harness</title>
	<meta
		name="description"
		content="A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know."
	/>
</svelte:head>

<div class="flex h-dvh">
	<Sidebar />
	<main class="min-w-0 flex-1">
		{@render children()}
	</main>
</div>
<SettingsDialog />
<CheatSheet />
