import { keyedLock } from "../platform/model/index.ts";

// Admission/deletion queue first, store queues inside. Never await same-chat reentry.
// shortcut: process-local ordering, coordinate shared storage before multi-process serving.
export const withChatOperation = keyedLock("chatOperation");
