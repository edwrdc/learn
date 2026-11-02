/** The session-scoped overlay seam: the
 *  chat page provides it; markdown/figure controls consume it. */
import type { SessionMermaidApi } from "./types";

export const SESSION_MERMAID = Symbol("lh:session-mermaid");

export type { SessionMermaidApi };
