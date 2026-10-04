import assert from "node:assert/strict";
import test from "node:test";
import { createAgentMailNotifier } from "../src/adapters.js";
import { createQuietWatcherServer } from "../src/server.js";

test("watch confirmation uses the configured inbox and requested acknowledgement recipient", async () => {
  const sends = [];
  const notifier = createAgentMailNotifier({
    apiKey: "test-key",
    inboxId: "jcz@agentmail.to",
    client: {
      inboxes: {
        messages: {
          async send(...args) {
            sends.push(args);
          },
        },
      },
    },
  });

  await notifier.sendWatchConfirmation({
    id: "4be0c6dc-c755-4ef1-9f1f-42da62435d1c",
    name: "Concert tickets",
    kind: "price_drop",
    query: "Current listed price for front-row concert tickets",
    recipientEmail: "alerts@example.test",
    checkIntervalMinutes: 60,
  });

  assert.equal(sends.length, 1);
  assert.equal(sends[0][0], "jcz@agentmail.to");
  assert.deepEqual(sends[0][1].to, ["quietwatch@agentmail.to"]);
  assert.equal(sends[0][1].subject, "[QuietWatcher] Watch is on: Concert tickets");
  assert.match(sends[0][1].text, /is on/);
  assert.match(sends[0][1].text, /Current listed price for front-row concert tickets/);
  assert.deepEqual(sends[0][2], { idempotencyKey: "watch-confirmation-4be0c6dc-c755-4ef1-9f1f-42da62435d1c" });
});

test("demo UI API runs the workflow and returns its changed state and source", async (context) => {
  const app = createQuietWatcherServer({
    env: {},
    host: "127.0.0.1",
    port: 0,
    onError: () => {},
  });
  const address = await app.listen();
  context.after(() => app.close());
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const healthResponse = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).mode, "demo");

  const pageResponse = await fetch(baseUrl);
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /Your quiet workflow/);

  const checkResponse = await fetch(`${baseUrl}/api/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(checkResponse.status, 202);
  const { id } = await checkResponse.json();

  let dashboard;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const response = await fetch(`${baseUrl}/api/dashboard`);
    dashboard = await response.json();
    if (dashboard.runs[0]?.id === id && dashboard.runs[0].status !== "running") break;
  }

  assert.equal(dashboard.runs[0].status, "success");
  assert.equal(dashboard.runs[0].output.alertsSent, 0);
  assert.equal(dashboard.recentActivity.length, 0);
});

test("partial live configuration stays in setup mode", async (context) => {
  const app = createQuietWatcherServer({
    env: { DATABASE_URL: "configured" },
    host: "127.0.0.1",
    port: 0,
    onError: () => {},
  });
  const address = await app.listen();
  context.after(() => app.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
  const health = await response.json();
  assert.equal(health.mode, "setup");
  assert.deepEqual(health.missing, [
    "EXA_API_KEY",
    "AGENTMAIL_API_KEY",
    "AGENTMAIL_INBOX_ID",
  ]);
});

test("demo UI can create a watch without sending mail", async (context) => {
  const app = createQuietWatcherServer({
    env: {},
    host: "127.0.0.1",
    port: 0,
    onError: () => {},
  });
  const address = await app.listen();
  context.after(() => app.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/api/watches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Concert tickets",
      kind: "price_drop",
      query: "Current listed price for front-row concert tickets",
      recipientEmail: "demo@example.test",
      checkIntervalMinutes: 60,
      targetPrice: 150,
    }),
  });
  assert.equal(response.status, 201);
  const result = await response.json();
  const { watch } = result;
  assert.equal(watch.name, "Concert tickets");
  assert.equal(watch.criteria.targetPrice, 150);
  assert.equal(result.acknowledgementEmail.sent, false);
  assert.equal(result.acknowledgementEmail.reason, "demo_mode");

  const dashboard = await (await fetch(`http://127.0.0.1:${address.port}/api/dashboard`)).json();
  assert.equal(dashboard.watches.length, 2);
});

test("live watch creation sends a confirmation to the configured address", async (context) => {
  let savedWatch;
  const confirmations = [];
  const app = createQuietWatcherServer({
    env: {
      DATABASE_URL: "configured",
      EXA_API_KEY: "configured",
      AGENTMAIL_API_KEY: "configured",
      AGENTMAIL_INBOX_ID: "jcz@agentmail.to",
    },
    dependencies: {
      enableScheduler: false,
      store: {
        async createWatch(input) {
          savedWatch = {
            id: "4be0c6dc-c755-4ef1-9f1f-42da62435d1c",
            ...input,
            isActive: true,
          };
          return savedWatch;
        },
        async getDashboard() {
          return { watches: [savedWatch], recentActivity: [] };
        },
      },
      searcher: { async search() { throw new Error("Not used by this test."); } },
      notifier: {
        async sendWatchConfirmation(watch) {
          confirmations.push(watch);
        },
        async send() {},
      },
    },
    host: "127.0.0.1",
    port: 0,
    onError: () => {},
  });
  const address = await app.listen();
  context.after(() => app.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/api/watches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Concert tickets",
      kind: "price_drop",
      query: "Current listed price for front-row concert tickets",
      recipientEmail: "alerts@example.test",
      checkIntervalMinutes: 60,
      targetPrice: 150,
    }),
  });

  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.acknowledgementEmail.sent, true);
  assert.equal(savedWatch.name, "Concert tickets");
  assert.deepEqual(confirmations, [savedWatch]);
});

test("watch remains created when its acknowledgement email fails", async (context) => {
  const savedWatch = {
    id: "4be0c6dc-c755-4ef1-9f1f-42da62435d1c",
    name: "Concert tickets",
  };
  const app = createQuietWatcherServer({
    env: {
      DATABASE_URL: "configured",
      EXA_API_KEY: "configured",
      AGENTMAIL_API_KEY: "configured",
      AGENTMAIL_INBOX_ID: "jcz@agentmail.to",
    },
    dependencies: {
      enableScheduler: false,
      store: { async createWatch() { return savedWatch; } },
      searcher: { async search() { throw new Error("Not used by this test."); } },
      notifier: {
        async sendWatchConfirmation() {
          throw new Error("AgentMail unavailable.");
        },
        async send() {},
      },
    },
    host: "127.0.0.1",
    port: 0,
    onError: () => {},
  });
  const address = await app.listen();
  context.after(() => app.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/api/watches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Concert tickets",
      kind: "price_drop",
      query: "Current listed price for front-row concert tickets",
      recipientEmail: "alerts@example.test",
      checkIntervalMinutes: 60,
      targetPrice: 150,
    }),
  });

  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.watch.id, savedWatch.id);
  assert.equal(result.acknowledgementEmail.sent, false);
  assert.match(result.acknowledgementEmail.error, /watch is on/i);
});
