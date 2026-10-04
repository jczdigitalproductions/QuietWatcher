import { Mastra } from "@mastra/core";
import { createQuietWatcherWorkflow } from "./workflow.js";

export function createQuietWatcherApp({ store, searcher, notifier, enableScheduler = true }) {
  const quietWatcherWorkflow = createQuietWatcherWorkflow({ store, searcher, notifier });
  const mastra = new Mastra({
    workflows: { quietWatcherWorkflow },
    scheduler: { enabled: enableScheduler },
  });
  return { mastra, workflow: quietWatcherWorkflow };
}
