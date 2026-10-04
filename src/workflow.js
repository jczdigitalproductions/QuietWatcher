import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
  exaOutputSchema,
  hasQualifyingChange,
  MIN_OBSERVATION_CONFIDENCE,
  observationSchema,
  parseExaObservation,
  stateFingerprint,
} from "./state.js";

const inputSchema = z.object({
  watchId: z.string().uuid().optional(),
  force: z.boolean().default(false),
});

const stateSchema = observationSchema;
const watchSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["price_drop", "ipo_pricing_window", "clinical_trial_readout"]),
  query: z.string(),
  criteria: z.record(z.string(), z.unknown()),
  recipientEmail: z.string().email(),
  checkIntervalMinutes: z.number().int().positive(),
  sourceDomain: z.string().nullable().default(null),
  sourceUrl: z.string().nullable().default(null),
  currentState: stateSchema.nullable(),
});

const sourceSchema = z.object({
  url: z.string().url(),
  domain: z.string().min(1),
  title: z.string(),
  publishedDate: z.string().nullable(),
});

const candidateSchema = z.object({
  watch: watchSchema,
  state: stateSchema,
  source: sourceSchema,
  fingerprint: z.string(),
  stateChanged: z.boolean(),
  shouldAlert: z.boolean(),
  rebase: z.boolean().default(false),
});

const outputSchema = z.object({
  checked: z.number().int(),
  changed: z.number().int(),
  alertsSent: z.number().int(),
});

const structuredExtractionPrompt = [
  "Extract the current state asked about by this watch from the returned source pages.",
  "Use only explicit facts in the sources; do not infer a change from a new article or a rewritten summary.",
  "Return status, summary, and event_date as strings; use an empty event_date if unknown.",
  "For price-drop watches, return value as an object with numeric amount and uppercase ISO 4217 currency code; never return a formatted price string.",
  "For other watches, return value as a stable canonical event name string.",
  "Return confidence as a number from 0 to 1 based on explicit support in the source pages.",
].join(" ");

function normalizeSourceUrl(value) {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.href;
}

export function createQuietWatcherWorkflow({ store, searcher, notifier }) {
  const findDueWatches = createStep({
    id: "find-due-watches",
    inputSchema,
    outputSchema: z.array(watchSchema),
    execute: async ({ inputData }) =>
      store.claimDueWatches({
        watchId: inputData.watchId,
        force: inputData.force,
      }),
  });

  const searchAndCompare = createStep({
    id: "search-and-compare",
    inputSchema: z.array(watchSchema),
    outputSchema: z.array(candidateSchema),
    execute: async ({ inputData: watches }) => {
      const candidates = [];
      for (const watch of watches) {
        try {
          const response = await searcher.search(watch.query, {
            ...(watch.sourceDomain ? { includeDomains: [watch.sourceDomain] } : {}),
            contents: { highlights: true },
            systemPrompt: [
              structuredExtractionPrompt,
              `Watch kind: ${watch.kind}.`,
              watch.sourceUrl
                ? `Use only facts from this exact pinned source URL: ${watch.sourceUrl}. Ignore other returned pages.`
                : "",
            ].filter(Boolean).join(" "),
            outputSchema: exaOutputSchema,
          });
          const source = response.results.find((result) => {
            try {
              const url = new URL(result.url);
              const canonicalUrl = new URL(result.url);
              canonicalUrl.search = "";
              canonicalUrl.hash = "";
              return (url.protocol === "http:" || url.protocol === "https:") &&
                (!watch.sourceDomain || url.hostname.toLowerCase() === watch.sourceDomain) &&
                (!watch.sourceUrl || canonicalUrl.href === normalizeSourceUrl(watch.sourceUrl));
            } catch {
              return false;
            }
          });
          if (!source) {
            throw new Error(
              `Exa returned no result matching the pinned source for watch "${watch.name}" (${watch.id}).`,
            );
          }
          if (!response.output || typeof response.output.content !== "object") {
            throw new Error(`Exa did not return structured observation data for watch "${watch.name}".`);
          }

          const state = parseExaObservation(response.output.content, watch.kind);
          if (state.confidence < MIN_OBSERVATION_CONFIDENCE) {
            await store.resetPendingObservation(watch.id);
            continue;
          }
          const sourceUrl = new URL(source.url);
          const sourceDomain = sourceUrl.hostname.toLowerCase();
          const canonicalUrl = new URL(source.url);
          canonicalUrl.search = "";
          canonicalUrl.hash = "";
          const previous = watch.currentState;
          const rebase = previous &&
            (!watch.sourceUrl ||
              (watch.kind === "price_drop" && typeof previous.value !== "object"));
          if (
            watch.kind === "price_drop" &&
            previous &&
            !rebase &&
            (typeof previous.value !== "object" ||
              previous.value.currency !== state.value.currency ||
              state.value.currency !== (watch.criteria.targetCurrency ?? "USD"))
          ) {
            await store.resetPendingObservation(watch.id);
            continue;
          }
          const stateChanged = !previous || rebase || stateFingerprint(previous) !== stateFingerprint(state);
          candidates.push({
            watch,
            state,
            source: {
              url: source.url,
              domain: sourceDomain,
              canonicalUrl: canonicalUrl.href,
              title: source.title ?? source.url,
              publishedDate: source.publishedDate ?? null,
            },
            fingerprint: stateFingerprint(state),
            stateChanged,
            rebase: Boolean(rebase),
            shouldAlert: !rebase && stateChanged && hasQualifyingChange(watch, previous, state),
          });
        } catch (error) {
          await store.resetPendingObservation(watch.id);
          throw error;
        }
      }
      return candidates;
    },
  });

  const persistAndNotify = createStep({
    id: "persist-and-notify",
    inputSchema: z.array(candidateSchema),
    outputSchema,
    execute: async ({ inputData: candidates }) => {
      for (const candidate of candidates) {
        await store.saveObservation(candidate);
      }

      const pendingAlerts = await store.listPendingAlerts();
      let alertsSent = 0;
      for (const alert of pendingAlerts) {
        await store.markAlertAttempted(alert.id);
        try {
          await notifier.send(alert);
        } catch (error) {
          await store.markAlertFailed(alert.id, error);
          throw error;
        }
        await store.markAlertSent(alert.id);
        alertsSent += 1;
      }

      return {
        checked: candidates.length,
        changed: candidates.filter((candidate) => candidate.stateChanged).length,
        alertsSent,
      };
    },
  });

  return createWorkflow({
    id: "quiet-watcher",
    inputSchema,
    outputSchema,
    schedule: {
      cron: "* * * * *",
      timezone: "UTC",
      inputData: {},
    },
  })
    .then(findDueWatches)
    .then(searchAndCompare)
    .then(persistAndNotify)
    .commit();
}
