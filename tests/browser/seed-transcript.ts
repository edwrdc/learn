/** Write a seeded transcript into a chat's durable store, through the app's
 *  own store code. Usage: tsx seed-transcript.ts <dataDir> <chatId> <messages.json> */
import * as fs from "node:fs";

const [dataDir, chatId, messagesFile] = process.argv.slice(2);
if (!dataDir || !chatId || !messagesFile) throw new Error("usage: seed-transcript.ts <dataDir> <chatId> <messages.json>");
process.env.LH_DATA_DIR = dataDir;
const { boot } = await import("../../src/boot.ts");
boot({ upkeep: false });
const { appendMessages, closeChatRuntime } = await import("../../src/session/durable.ts");
await appendMessages(chatId, JSON.parse(fs.readFileSync(messagesFile, "utf8")));
await closeChatRuntime(chatId);
process.exit(0);
