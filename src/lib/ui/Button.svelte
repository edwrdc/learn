<script lang="ts">
	import { cn } from "$lib/utils";
	import type { Snippet } from "svelte";

	let {
		variant = "default",
		size = "default",
		class: className = "",
		type = "button",
		disabled = false,
		children,
		...rest
	}: {
		variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
		size?: "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";
		class?: string;
		type?: "button" | "submit" | "reset";
		disabled?: boolean;
		children?: Snippet;
		[key: string]: unknown;
	} = $props();

	const VARIANTS: Record<string, string> = {
		default: "bg-primary text-primary-foreground hover:bg-primary/90",
		destructive: "bg-destructive text-white hover:bg-destructive/90",
		outline: "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
		secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
		ghost: "hover:bg-accent hover:text-accent-foreground",
		link: "text-primary underline-offset-4 hover:underline",
	};
	const SIZES: Record<string, string> = {
		default: "h-9 px-4 py-2",
		xs: "h-6 gap-1 rounded-md px-2 text-xs",
		sm: "h-8 gap-1.5 rounded-md px-3",
		lg: "h-10 rounded-md px-6",
		icon: "size-9",
		"icon-xs": "size-6 rounded-md",
		"icon-sm": "size-8",
		"icon-lg": "size-10",
	};
</script>

<button
	{type}
	{disabled}
	class={cn(
		"inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
		VARIANTS[variant],
		SIZES[size],
		className,
	)}
	{...rest}
>
	{@render children?.()}
</button>
