<script lang="ts">
	import type { PageProps } from "./$types";
	import ChatPage from "$lib/chat/ChatPage.svelte";

	let { data }: PageProps = $props();
</script>

{#key data.chatId}
	<ChatPage
		chatId={data.chatId}
		title={data.title}
		kind={data.kind}
		initialMessages={data.initialMessages}
		initialPrompt={data.initialPrompt}
		initiallyInFlight={data.initiallyInFlight}
		initiallyCompacting={data.initiallyCompacting}
		initialConfigured={data.initialConfigured}
	/>
{/key}
