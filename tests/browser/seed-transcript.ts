/** Write a seeded transcript into a chat's durable store, through the app's
 *  own store code. Usage: tsx seed-transcript.ts <dataDir> <chatId> <messages.json> */
const [dataDir, chatId, messagesFile] = process.argv.slice(2);
process.env.LH_DATA_DIR = dataDir;
const fs = await import("node:fs");
const { boot } = await import("../../src/boot.ts");
boot({ upkeep: false });
const { appendMessages, closeChatRuntime } = await import("../../src/session/durable.ts");
await appendMessages(chatId, JSON.parse(fs.readFileSync(messagesFile, "utf8")));
await closeChatRuntime(chatId);
process.exit(0);
