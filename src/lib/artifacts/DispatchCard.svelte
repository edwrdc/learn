<script lang="ts">
	import { now } from "$lib/state/now.svelte";
	import { getContext } from "svelte";
	import { Check, Settings, X } from "@lucide/svelte";
	import { type JobKind, type JobRecord } from "@/src/jobs/model";
	import { jobAgentLabel } from "@/src/tools/model";
	import { CHAT_ACTIONS, type ChatActions } from "$lib/session-context";
	import BrailleSpinner from "$lib/ui/BrailleSpinner.svelte";

	let { toolCallId, kind, jobs: jobsProp }: { toolCallId: string; kind: JobKind; jobs?: JobRecord[] } = $props();
	const jobs = $derived(jobsProp ?? []);
	const actions = getContext<ChatActions | null>(CHAT_ACTIONS) ?? null;
	const job = $derived(jobs.find((j) => j.toolCallId === toolCallId) ?? null);
	const label = $derived(jobAgentLabel(kind));
	const elapsed = $derived(job?.createdAt ? Math.max(0, Math.round((now() - Date.parse(job.createdAt)) / 1000)) : null);
</script>

{#if !job || job.status === "running"}
	<div class="rounded-xl border bg-card p-4 text-card-foreground" data-testid="dispatch-card">
		<div class="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
			<BrailleSpinner label={`${label} running`} />
			{label}
			{#if elapsed !== null}<span class="font-normal">· {elapsed}s</span>{/if}
		</div>
		{#if job?.activity}
			<div class="mt-1 truncate text-sm text-muted-foreground" data-testid="dispatch-activity-line">{job.activity}</div>
		{/if}
		{#if !job}
			<div class="mt-1 text-sm text-muted-foreground" data-testid="dispatch-pending">Dispatched…</div>
		{/if}
	</div>
{:else if job.refusal === "models_not_configured"}
	<div class="flex items-center gap-2 text-xs text-muted-foreground" data-testid="dispatch-refused">
		<Settings class="size-3.5" />
		<span class="font-medium uppercase tracking-wide">{label}</span>
		<span>needs model setup</span>
		{#if actions}
			<button type="button" data-testid="dispatch-setup-link" onclick={actions.openSetup} class="ml-1 rounded-sm border border-border bg-card px-2 py-0.5 font-ui normal-case tracking-normal text-foreground transition-colors hover:border-muted-foreground/50">Set up models</button>
		{/if}
	</div>
{:else if job.refusal === "provider_key_missing"}
	<div class="flex items-center gap-2 text-xs text-muted-foreground" data-testid="dispatch-refused">
		<Settings class="size-3.5" />
		<span class="font-medium uppercase tracking-wide">{label}</span>
		<span>needs a provider key</span>
		{#if actions}
			<button type="button" data-testid="dispatch-setup-link" onclick={actions.openSetup} class="ml-1 rounded-sm border border-border bg-card px-2 py-0.5 font-ui normal-case tracking-normal text-foreground transition-colors hover:border-muted-foreground/50">Add a key</button>
		{/if}
	</div>
{:else if job.status === "error"}
	<div class="flex items-center gap-2 text-xs text-muted-foreground" data-testid="dispatch-settled">
		<X class="size-3.5 text-red-500" /><span class="font-medium uppercase tracking-wide">{label}</span><span>failed</span>
	</div>
{:else}
	<div class="flex items-center gap-2 text-xs text-muted-foreground" data-testid="dispatch-settled">
		<Check class="size-3.5" /><span class="font-medium uppercase tracking-wide">{label}</span><span>delivered</span>
	</div>
{/if}
