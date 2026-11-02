<script lang="ts">
	import type { PageProps } from "./$types";
	import NewSessionPage from "$lib/home/NewSessionPage.svelte";

	let { data }: PageProps = $props();
</script>

<NewSessionPage initialConfigured={data.initialConfigured} mode={data.mode} />
