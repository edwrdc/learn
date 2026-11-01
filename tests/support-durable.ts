/**
 * Wire the agent-layer background seam to the real durable runner for tests
 * that drive a role directly (no chat-handler import in the file). Import
 * after ./support-tmp-data.ts.
 */
import { setBackgroundRetire, setBackgroundRun } from "../src/agent/subagents/durable-run.ts";
import { retireBackgroundRun, runBackgroundConversation } from "../src/server/durable-background.ts";

setBackgroundRun(runBackgroundConversation);
setBackgroundRetire(retireBackgroundRun);
