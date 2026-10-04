import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createQuietWatcherWorkflow } from "./workflow.js";
import { formatObservationValue } from "./state.js";

export const demoWatchId = "c47fa8e4-a372-4ab7-8653-57414b4aa3a1";
const sourceUrl = "https://shop.example.test/products/quiet-headphones";

export function createDemoEnvironment() {
  const watches = new Map([
    [
      demoWatchId,
      {
        id: demoWatchId,
        name: "Quiet headphones price",
        kind: "price_drop",
        query: "Current price for Acme Quiet headphones",
        criteria: { targetPrice: 45 },
        recipientEmail: "demo@example.test",
        checkIntervalMinutes: 15,
        sourceDomain: "shop.example.test",
        sourceUrl,
        currentState: {
          value: { amount: 59.99, currency: "USD" },
          status: "available",
          summary: "Known baseline price.",
          eventDate: "",
          confidence: 0.99,
        },
        lastCheckedAt: null,
        nextCheckAt: new Date().toISOString(),
      },
    ],
  ]);
  const messages = [];
  const observations = [];
  const pending = [];
  const pendingFingerprints = new Map();
  const store = {
    async claimDueWatches({ watchId = null, force = false }) {
      const now = Date.now();
      return [...watches.values()]
        .filter(
          (watch) =>
            (!watchId || watch.id === watchId) &&
            (force || !watch.nextCheckAt || Date.parse(watch.nextCheckAt) <= now),
        )
        .map((watch) => {
          watch.nextCheckAt = new Date(
            now + watch.checkIntervalMinutes * 60_000,
          ).toISOString();
          return {
            ...watch,
            currentState: watch.currentState && { ...watch.currentState },
          };
        });
    },
    async saveObservation(candidate) {
      const watch = watches.get(candidate.watch.id);
      if (!watch) throw new Error(`Demo watch ${candidate.watch.id} was not found.`);
      watch.lastCheckedAt = new Date().toISOString();
      if (!candidate.stateChanged) {
        pendingFingerprints.delete(watch.id);
        return;
      }
      const requiresConfirmation =
        watch.kind === "price_drop" && candidate.shouldAlert && !candidate.rebase;
      if (
        requiresConfirmation &&
        pendingFingerprints.get(watch.id) !== candidate.fingerprint
      ) {
        pendingFingerprints.set(watch.id, candidate.fingerprint);
        return;
      }
      pendingFingerprints.delete(watch.id);
      observations.unshift({
        id: randomUUID(),
        watchName: watch.name,
        state: candidate.state,
        summary: candidate.stateChanged ? candidate.state.summary : "No meaningful change detected.",
        sourceUrl: candidate.source.url,
        sourceTitle: candidate.source.title,
        observedAt: watch.lastCheckedAt,
        alertStatus: candidate.shouldAlert ? "sent" : null,
        changed: candidate.stateChanged,
      });
      watch.currentState = candidate.state;
      watch.sourceDomain ??= candidate.source.domain;
      observations[0].state = candidate.state;
      observations[0].summary = candidate.state.summary;
      if (candidate.shouldAlert) {
        pending.push({
          id: randomUUID(),
          recipientEmail: watch.recipientEmail,
          watchName: watch.name,
          state: candidate.state,
          summary: candidate.state.summary,
          sourceUrl: candidate.source.url,
          sourceTitle: candidate.source.title,
        });
      }
    },
    async resetPendingObservation(watchId) {
      pendingFingerprints.delete(watchId);
      const watch = watches.get(watchId);
      if (watch) watch.lastCheckedAt = new Date().toISOString();
    },
    async listPendingAlerts() {
      return pending;
    },
    async markAlertAttempted() {},
    async markAlertFailed() {},
    async markAlertSent(id) {
      const index = pending.findIndex((alert) => alert.id === id);
      if (index !== -1) pending.splice(index, 1);
    },
    async getDashboard() {
      return {
        watches: [...watches.values()].map((watch) => ({
          ...watch,
          currentState: watch.currentState && { ...watch.currentState },
        })),
        recentActivity: observations.slice(0, 20),
      };
    },
    async createWatch(input) {
      const watch = {
        id: randomUUID(),
        ...input,
        currentState: null,
        lastCheckedAt: null,
        nextCheckAt: new Date().toISOString(),
      };
      watches.set(watch.id, watch);
      return watch;
    },
  };
  const searcher = {
    async search() {
      return {
        output: {
          content: {
            value: { amount: 39.99, currency: "USD" },
            status: "available",
            summary: "The listed price is now $39.99, down from $59.99.",
            event_date: "",
            confidence: 0.99,
          },
        },
        results: [
          {
            url: sourceUrl,
            title: "Acme Quiet Headphones - $39.99",
            publishedDate: "2026-10-03T00:00:00.000Z",
          },
        ],
      };
    },
  };
  const notifier = {
    async send(alert) {
      messages.push(alert);
    },
  };
  return { store, searcher, notifier, messages, observations };
}

export async function runDemo() {
  const dependencies = createDemoEnvironment();
  const workflow = createQuietWatcherWorkflow(dependencies);
  const run = async () => {
    const workflowRun = await workflow.createRun();
    return workflowRun.start({
      inputData: { watchId: demoWatchId, force: true },
    });
  };

  await run();
  await run();
  return dependencies;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { messages } = await runDemo();
  console.info(`Demo complete: sent ${messages.length} alert.`);
  for (const message of messages) {
    console.info(`${message.watchName}: ${formatObservationValue(message.state.value)}`);
    console.info(`Source: ${message.sourceUrl}`);
  }
}
