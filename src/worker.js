import "dotenv/config";
import { createAgentMailNotifier, createExaSearcher } from "./adapters.js";
import { createPostgresStore } from "./postgres-store.js";
import { createQuietWatcherApp } from "./mastra.js";

const requiredVariables = [
  "DATABASE_URL",
  "EXA_API_KEY",
  "AGENTMAIL_API_KEY",
  "AGENTMAIL_INBOX_ID",
];
const missingVariables = requiredVariables.filter((name) => !process.env[name]);
if (missingVariables.length > 0) {
  throw new Error(`Missing live configuration: ${missingVariables.join(", ")}.`);
}

const store = createPostgresStore(process.env.DATABASE_URL);
const searcher = createExaSearcher(process.env.EXA_API_KEY);
const notifier = createAgentMailNotifier({
  apiKey: process.env.AGENTMAIL_API_KEY,
  inboxId: process.env.AGENTMAIL_INBOX_ID,
});

createQuietWatcherApp({ store, searcher, notifier });
console.info("QuietWatcher Mastra scheduler is running (UTC, every minute).");
