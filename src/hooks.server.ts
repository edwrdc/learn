import type { ServerInit } from "@sveltejs/kit";
import { boot } from "./boot.ts";

export const init: ServerInit = () => {
	boot();
};
