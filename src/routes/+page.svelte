<script lang="ts">
	import type { PageProps } from "./$types";
	import HomePage from "$lib/home/HomePage.svelte";

	let { data }: PageProps = $props();
</script>

<HomePage initialConfigured={data.initialConfigured} rendering={data.rendering} />
