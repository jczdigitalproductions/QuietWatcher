import { config as loadEnv } from "dotenv";
import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createAgentMailNotifier, createExaSearcher } from "./adapters.js";
import { createDemoEnvironment } from "./demo.js";
import { createQuietWatcherApp } from "./mastra.js";
import { createPostgresStore } from "./postgres-store.js";
import { currencyCodeSchema } from "./state.js";

const root = resolve(fileURLToPath(new URL("../public", import.meta.url)));
loadEnv({ path: fileURLToPath(new URL("../.env", import.meta.url)) });
const requiredVariables = [
  "DATABASE_URL",
  "EXA_API_KEY",
  "AGENTMAIL_API_KEY",
  "AGENTMAIL_INBOX_ID",
];
const watchRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["price_drop", "ipo_pricing_window", "clinical_trial_readout"]),
  query: z.string().trim().min(8).max(1000),
  recipientEmail: z.string().trim().email().max(254),
  checkIntervalMinutes: z.number().int().min(1).max(10080),
  targetPrice: z.number().positive().max(1_000_000).optional(),
  targetCurrency: currencyCodeSchema.optional(),
  alertStatuses: z.array(z.string().trim().min(1).max(48)).max(12).optional(),
}).superRefine((watch, context) => {
  if (watch.kind === "price_drop" && watch.targetPrice === undefined) {
    context.addIssue({
      code: "custom",
      path: ["targetPrice"],
      message: "A target price is required for price-drop watches.",
    });
  }
});

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32_768) {
      const error = new Error("Request body exceeds 32 KB.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

function configureRuntime(env, dependencies = {}) {
  if (env.DEMO_MODE === "true") {
    const demo = createDemoEnvironment();
    return {
      mode: "demo",
      store: dependencies.store ?? demo.store,
      searcher: dependencies.searcher ?? demo.searcher,
      notifier: dependencies.notifier ?? demo.notifier,
      enableScheduler: false,
    };
  }

  const missing = requiredVariables.filter((name) => !env[name]);
  if (missing.length === requiredVariables.length) {
    const demo = createDemoEnvironment();
    return {
      mode: "demo",
      store: dependencies.store ?? demo.store,
      searcher: dependencies.searcher ?? demo.searcher,
      notifier: dependencies.notifier ?? demo.notifier,
      enableScheduler: false,
    };
  }
  if (missing.length > 0) {
    return { mode: "setup", missing, store: null, workflow: null };
  }

  return {
    mode: "live",
    store: dependencies.store ?? createPostgresStore(env.DATABASE_URL),
    searcher: dependencies.searcher ?? createExaSearcher(env.EXA_API_KEY),
    notifier: dependencies.notifier ?? createAgentMailNotifier({
      apiKey: env.AGENTMAIL_API_KEY,
      inboxId: env.AGENTMAIL_INBOX_ID,
    }),
    enableScheduler: dependencies.enableScheduler ?? true,
  };
}

function contentType(path) {
  const types = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  return types[extname(path)] ?? "application/octet-stream";
}

async function serveStatic(request, response) {
  const url = new URL(request.url, "http://localhost");
  const requestedPath = decodeURIComponent(url.pathname);
  const fileName = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
  const filePath = resolve(root, fileName);
  if (!filePath.startsWith(`${root}${sep}`)) {
    json(response, 404, { error: "Not found." });
    return;
  }
  try {
    const file = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentType(filePath),
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    response.end(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    json(response, 404, { error: "Not found." });
  }
}

export function createQuietWatcherServer({
  env = process.env,
  host = "127.0.0.1",
  port = 4173,
  onError = console.error,
  dependencies = {},
} = {}) {
  const runtime = configureRuntime(env, dependencies);
  const workflowApp =
    runtime.mode === "setup"
      ? null
      : createQuietWatcherApp({
          store: runtime.store,
          searcher: runtime.searcher,
          notifier: runtime.notifier,
          enableScheduler: runtime.enableScheduler,
        });
  const runs = new Map();
  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");

      if (request.method === "GET" && url.pathname === "/api/health") {
        json(response, 200, {
          mode: runtime.mode,
          missing: runtime.mode === "setup" ? runtime.missing : [],
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        const dashboard = runtime.store
          ? await runtime.store.getDashboard()
          : { watches: [], recentActivity: [] };
        json(response, 200, {
          ...dashboard,
          runs: [...runs.values()].slice(-10).reverse(),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/check") {
        if (!workflowApp) {
          json(response, 503, { error: "Configure all live service credentials before checking watches." });
          return;
        }
        const input = z.object({ watchId: z.string().uuid().optional() }).parse(await readJson(request));
        const run = { id: randomUUID(), status: "running", startedAt: new Date().toISOString() };
        runs.set(run.id, run);
        json(response, 202, run);
        void (async () => {
          try {
            const workflowRun = await workflowApp.workflow.createRun();
            const result = await workflowRun.start({
              inputData: { watchId: input.watchId, force: true },
            });
            run.status = "success";
            run.output = result.steps?.["persist-and-notify"]?.output ?? result.result ?? null;
            run.finishedAt = new Date().toISOString();
          } catch (error) {
            run.status = "failed";
            run.error = "Check failed. See the QuietWatcher server logs for details.";
            run.finishedAt = new Date().toISOString();
            onError("QuietWatcher check failed:", error);
          }
        })();
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/watches") {
        if (!runtime.store) {
          json(response, 503, { error: "Configure all live service credentials before creating live watches." });
          return;
        }
        const parsed = watchRequestSchema.safeParse(await readJson(request));
        if (!parsed.success) {
          json(response, 400, { error: parsed.error.issues[0]?.message ?? "Invalid watch." });
          return;
        }
        const { targetPrice, targetCurrency = "USD", alertStatuses = [], ...input } = parsed.data;
        const criteria =
          input.kind === "price_drop"
            ? { targetPrice, targetCurrency }
            : { alertStatuses };
        const watch = await runtime.store.createWatch({ ...input, criteria });
        if (runtime.mode === "demo") {
          json(response, 201, {
            watch,
            acknowledgementEmail: { sent: false, reason: "demo_mode" },
          });
          return;
        }
        try {
          await runtime.notifier.sendWatchConfirmation(watch);
          json(response, 201, { watch, acknowledgementEmail: { sent: true } });
        } catch (error) {
          onError("QuietWatcher watch confirmation email failed:", error);
          json(response, 201, {
            watch,
            acknowledgementEmail: {
              sent: false,
              error: "The watch is on, but its confirmation email could not be sent.",
            },
          });
        }
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/")) {
        json(response, 404, { error: "Not found." });
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        json(response, 405, { error: "Method not allowed." });
        return;
      }
      await serveStatic(request, response);
    } catch (error) {
      onError("QuietWatcher server request failed:", error);
      const status = error instanceof z.ZodError ? 400 : (error.status ?? 500);
      json(response, status, {
        error:
          status < 500
            ? (error instanceof Error ? error.message : "Invalid request.")
            : "Unexpected server error. Check the QuietWatcher server logs.",
      });
    }
  });

  return {
    server,
    listen() {
      return new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolveListen(server.address());
        });
      });
    },
    close() {
      return new Promise((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  const app = createQuietWatcherServer({
    port: Number(process.env.PORT ?? 4173),
  });
  const address = await app.listen();
  console.info(`QuietWatcher ${configureRuntime(process.env).mode} UI listening at http://${address.address}:${address.port}`);
}
