import { AgentMailClient } from "agentmail";
import Exa from "exa-js";
import { escapeHtml, formatObservationValue } from "./state.js";

export function createExaSearcher(apiKey) {
  if (!apiKey) throw new Error("EXA_API_KEY is required.");
  const exa = new Exa(apiKey);
  return {
    search: (query, options) => exa.search(query, options),
  };
}

export function createAgentMailNotifier({ apiKey, inboxId, client: providedClient }) {
  if (!apiKey) throw new Error("AGENTMAIL_API_KEY is required.");
  if (!inboxId) throw new Error("AGENTMAIL_INBOX_ID is required.");

  const client = providedClient ?? new AgentMailClient({ apiKey });
  return {
    async sendWatchConfirmation(watch) {
      const subject = `[QuietWatcher] Watch is on: ${watch.name}`;
      const text = [
        `Your QuietWatcher watch "${watch.name}" is on.`,
        "",
        `Type: ${watch.kind.replaceAll("_", " ")}`,
        `Monitoring: ${watch.query}`,
        `Check interval: every ${watch.checkIntervalMinutes} minutes`,
        `Change alerts will be sent to: ${watch.recipientEmail}`,
      ].join("\n");
      const html = [
        `<p>Your QuietWatcher watch "<strong>${escapeHtml(watch.name)}</strong>" is on.</p>`,
        `<ul><li>Type: ${escapeHtml(watch.kind.replaceAll("_", " "))}</li>`,
        `<li>Monitoring: ${escapeHtml(watch.query)}</li>`,
        `<li>Check interval: every ${watch.checkIntervalMinutes} minutes</li>`,
        `<li>Change alerts will be sent to: ${escapeHtml(watch.recipientEmail)}</li></ul>`,
      ].join("");

      await client.inboxes.messages.send(
        inboxId,
        {
          to: ["quietwatch@agentmail.to"],
          subject,
          text,
          html,
        },
        { idempotencyKey: `watch-confirmation-${watch.id}` },
      );
    },
    async send(alert) {
      const subject = `[QuietWatcher] ${alert.watchName} changed`;
      const text = [
        alert.summary,
        `Current value: ${formatObservationValue(alert.state.value)}`,
        `Status: ${alert.state.status}`,
        `Source: ${alert.sourceTitle}`,
        alert.sourceUrl,
      ].join("\n");
      const html = [
        `<p>${escapeHtml(alert.summary)}</p>`,
        `<p>Current value: ${escapeHtml(formatObservationValue(alert.state.value))}<br>Status: ${escapeHtml(alert.state.status)}</p>`,
        `<p>Source: <a href="${escapeHtml(alert.sourceUrl)}">${escapeHtml(alert.sourceTitle)}</a></p>`,
      ].join("");

      await client.inboxes.messages.send(
        inboxId,
        {
          to: [alert.recipientEmail],
          subject,
          text,
          html,
        },
        { idempotencyKey: alert.id },
      );
    },
  };
}
