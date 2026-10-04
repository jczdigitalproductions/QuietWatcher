import assert from "node:assert/strict";
import test from "node:test";
import { runDemo } from "../src/demo.js";
import { createQuietWatcherWorkflow } from "../src/workflow.js";

test("price drop is confirmed twice from one source before sending an alert", async () => {
  const { messages, observations } = await runDemo();

  assert.equal(observations.filter((observation) => observation.changed).length, 1);
  assert.equal(observations.length, 1);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].state.value, { amount: 39.99, currency: "USD" });
  assert.equal(messages[0].sourceUrl, "https://shop.example.test/products/quiet-headphones");
});

function makeWatch() {
  return {
    id: "c47fa8e4-a372-4ab7-8653-57414b4aa3a1",
    name: "Quiet headphones price",
    kind: "price_drop",
    query: "Current price for Acme Quiet headphones",
    criteria: { targetPrice: 45, targetCurrency: "USD" },
    recipientEmail: "demo@example.test",
    checkIntervalMinutes: 15,
    sourceDomain: "shop.example.test",
    sourceUrl: "https://shop.example.test/item",
    currentState: {
      value: { amount: 59.99, currency: "USD" },
      status: "available",
      summary: "Known baseline price.",
      eventDate: "",
      confidence: 0.99,
    },
  };
}

async function executeWorkflow({ watch, search }) {
  let savedCandidate;
  let resetCount = 0;
  const store = {
    async claimDueWatches() { return [watch]; },
    async saveObservation(candidate) { savedCandidate = candidate; },
    async resetPendingObservation() { resetCount += 1; },
    async listPendingAlerts() { return []; },
  };
  const workflow = createQuietWatcherWorkflow({
    store,
    searcher: { search },
    notifier: { async send() {} },
  });
  const run = await workflow.createRun();
  return {
    result: await run.start({ inputData: { force: true } }),
    savedCandidate,
    resetCount,
  };
}

test("uses only the pinned source domain for price comparisons", async () => {
  const watch = makeWatch();
  let searchOptions;
  const { savedCandidate } = await executeWorkflow({
    watch,
    async search(_query, options) {
      searchOptions = options;
      return {
        output: {
          content: {
            value: { amount: 39.99, currency: "USD" },
            status: "available",
            summary: "Price listed at $39.99.",
            event_date: "",
            confidence: 0.95,
          },
        },
        results: [
          { url: "https://amazon.example/item", title: "Different listing" },
          { url: "https://shop.example.test/refurbished", title: "Same domain, different listing" },
          { url: "https://shop.example.test/item", title: "Pinned retailer" },
        ],
      };
    },
  });

  assert.deepEqual(searchOptions.includeDomains, ["shop.example.test"]);
  assert.match(searchOptions.systemPrompt, /Use only facts from this exact pinned source URL/);
  assert.equal(savedCandidate.source.domain, "shop.example.test");
  assert.equal(savedCandidate.source.url, "https://shop.example.test/item");
});

test("empty searches and low-confidence extraction do not save or replace the baseline", async () => {
  const initialState = makeWatch().currentState;
  const scenarios = [
    {
      name: "empty results",
      async search() {
        return { results: [], output: { content: {} } };
      },
      rejects: true,
    },
    {
      name: "failed search",
      async search() {
        throw new Error("Search unavailable.");
      },
      rejects: true,
    },
    {
      name: "low confidence",
      async search() {
        return {
          output: {
            content: {
              value: { amount: 10, currency: "USD" },
              status: "available",
              summary: "Possibly a refurbished listing.",
              event_date: "",
              confidence: 0.79,
            },
          },
          results: [{ url: "https://shop.example.test/item", title: "Pinned retailer" }],
        };
      },
      rejects: false,
    },
    {
      name: "invalid price representation",
      async search() {
        return {
          output: {
            content: {
              value: "$10.00",
              status: "available",
              summary: "Price listed at $10.00.",
              event_date: "",
              confidence: 0.99,
            },
          },
          results: [{ url: "https://shop.example.test/item", title: "Pinned retailer" }],
        };
      },
      rejects: true,
    },
  ];

  for (const scenario of scenarios) {
    const watch = makeWatch();
    let savedCandidate;
    let resetCount = 0;
    const store = {
      async claimDueWatches() { return [watch]; },
      async saveObservation(candidate) {
        savedCandidate = candidate;
        watch.currentState = candidate.state;
      },
      async resetPendingObservation() { resetCount += 1; },
      async listPendingAlerts() { return []; },
    };
    const workflow = createQuietWatcherWorkflow({
      store,
      searcher: { search: scenario.search },
      notifier: { async send() {} },
    });
    const run = await workflow.createRun();
    const execution = run.start({ inputData: { force: true } });
    await execution;

    assert.equal(savedCandidate, undefined, scenario.name);
    assert.equal(resetCount, 1, scenario.name);
    assert.deepEqual(watch.currentState, initialState, scenario.name);
  }
});
