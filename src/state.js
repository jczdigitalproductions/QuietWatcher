import { createHash } from "node:crypto";
import { z } from "zod";

export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .refine((currency) => {
    try {
      new Intl.NumberFormat("en-US", { style: "currency", currency });
      return true;
    } catch {
      return false;
    }
  }, "Currency must be a valid ISO 4217 code.");

export const observationSchema = z.object({
  value: z.union([
    z.object({
      amount: z.number().finite().nonnegative(),
      currency: currencyCodeSchema,
    }),
    z.string().trim().min(1),
  ]),
  status: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  eventDate: z.string().trim(),
  confidence: z.number().min(0).max(1).optional(),
});

const exaObservationSchema = z.object({
  value: z.union([
    z.object({
      amount: z.number().finite().nonnegative(),
      currency: currencyCodeSchema,
    }),
    z.string(),
  ]),
  status: z.string(),
  summary: z.string(),
  event_date: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

export const MIN_OBSERVATION_CONFIDENCE = 0.8;

export const exaOutputSchema = {
  type: "object",
  properties: {
    value: {
      oneOf: [
        {
          type: "object",
          properties: {
            amount: { type: "number", minimum: 0 },
            currency: { type: "string", pattern: "^[A-Z]{3}$" },
          },
          required: ["amount", "currency"],
          additionalProperties: false,
        },
        { type: "string" },
      ],
      description: "For price-drop watches return {amount, currency}; otherwise return the canonical event value string.",
    },
    status: {
      type: "string",
      description: "The current event or availability status in a short normalized form.",
    },
    summary: {
      type: "string",
      description: "A concise factual description supported by the returned source pages.",
    },
    event_date: {
      type: "string",
      description: "The relevant event or readout date, or an empty string when unknown.",
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Confidence from 0 to 1 that the extracted state is explicit and supported by the source.",
    },
  },
  required: ["value", "status", "summary", "event_date", "confidence"],
};

export function parseExaObservation(content, kind) {
  const parsed = exaObservationSchema.safeParse(content);
  if (!parsed.success) {
    throw new Error(`Exa did not return the required observation shape: ${parsed.error.message}`);
  }
  if (kind === "price_drop" && typeof parsed.data.value === "string") {
    throw new Error("Exa must return a numeric amount and currency for price-drop watches.");
  }
  if (kind !== "price_drop" && typeof parsed.data.value !== "string") {
    throw new Error("Exa must return a string value for non-price watches.");
  }
  return observationSchema.parse({
    value: parsed.data.value,
    status: parsed.data.status,
    summary: parsed.data.summary,
    eventDate: parsed.data.event_date ?? "",
    confidence: parsed.data.confidence,
  });
}

export function stateFingerprint(state) {
  const identity = JSON.stringify({
    value: typeof state.value === "string"
      ? state.value.trim().toLocaleLowerCase("en-US")
      : { amount: state.value.amount, currency: state.value.currency },
    status: state.status.trim().toLocaleLowerCase("en-US"),
    eventDate: state.eventDate.trim(),
  });
  return createHash("sha256").update(identity).digest("hex");
}

export function formatObservationValue(value) {
  if (typeof value === "string") return value;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: value.currency,
  }).format(value.amount);
}

function alertStatuses(watch) {
  if (Array.isArray(watch.criteria.alertStatuses)) {
    return watch.criteria.alertStatuses.map((status) => String(status).toLocaleLowerCase("en-US"));
  }
  if (watch.kind === "ipo_pricing_window") return ["open", "priced", "pricing"];
  if (watch.kind === "clinical_trial_readout") {
    return ["readout", "results posted", "reported", "published"];
  }
  return [];
}

export function hasQualifyingChange(watch, previous, current) {
  if (!previous || stateFingerprint(previous) === stateFingerprint(current)) return false;

  if (watch.kind === "price_drop") {
    if (
      typeof previous.value !== "object" ||
      typeof current.value !== "object" ||
      previous.value.currency !== current.value.currency
    ) return false;
    const previousPrice = previous.value.amount;
    const currentPrice = current.value.amount;
    const targetPrice = Number(watch.criteria.targetPrice);
    const targetCurrency = watch.criteria.targetCurrency ?? "USD";
    return (
      current.value.currency === targetCurrency &&
      Number.isFinite(targetPrice) &&
      currentPrice < previousPrice &&
      currentPrice <= targetPrice
    );
  }

  const targets = alertStatuses(watch);
  const currentStatus = current.status.toLocaleLowerCase("en-US");
  return targets.length > 0
    ? targets.includes(currentStatus)
    : stateFingerprint(previous) !== stateFingerprint(current);
}

export function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
