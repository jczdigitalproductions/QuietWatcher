const refs = {
  activeCount: document.querySelector("#active-count"),
  addButtons: [
    document.querySelector("#add-watch-button"),
    document.querySelector("#add-watch-row"),
  ],
  activityList: document.querySelector("#activity-list"),
  alertStatusesField: document.querySelector("#alert-statuses-field"),
  checkButton: document.querySelector("#check-now-button"),
  connectionLabel: document.querySelector("#connection-label"),
  dialog: document.querySelector("#watch-dialog"),
  dialogClose: document.querySelector("#dialog-close"),
  form: document.querySelector("#watch-form"),
  formError: document.querySelector("#form-error"),
  lastCheck: document.querySelector("#last-check"),
  lastCheckFoot: document.querySelector("#last-check-foot"),
  modePill: document.querySelector("#mode-pill"),
  quietCount: document.querySelector("#quiet-count"),
  runStatus: document.querySelector("#workflow-run-status"),
  targetPriceField: document.querySelector("#target-price-field"),
  watchCount: document.querySelector("#watch-heading-count"),
  watchList: document.querySelector("#watch-list"),
  watchNavCount: document.querySelector("#watch-nav-count"),
  watchStatFoot: document.querySelector("#watch-stat-foot"),
  watchKind: document.querySelector("#watch-kind"),
};

let mode = "connecting";
let requestBusy = false;
let toastTimer;
let runPollTimer;
let lastRenderedRunId;
let quietChecks = 0;

const kindLabels = {
  price_drop: "Price drop",
  ipo_pricing_window: "IPO pricing",
  clinical_trial_readout: "Trial readout",
};
const kindIcons = {
  price_drop: "↓",
  ipo_pricing_window: "↗",
  clinical_trial_readout: "✳",
};

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatTime(value, fallback = "Not yet checked") {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 45) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatNextCheck(value, active) {
  if (active === false) return "Paused";
  if (!value) return "On schedule";
  const minutes = Math.ceil((new Date(value).getTime() - Date.now()) / 60_000);
  if (minutes <= 0) return "Due now";
  if (minutes < 60) return `In ${minutes} min`;
  if (minutes < 1440) return `In ${Math.ceil(minutes / 60)} hr`;
  return `In ${Math.ceil(minutes / 1440)} days`;
}

function showToast(message, isError = false) {
  document.querySelector(".toast")?.remove();
  const toast = makeElement("div", `toast${isError ? " is-error" : ""}`, message);
  toast.setAttribute("role", isError ? "alert" : "status");
  document.body.append(toast);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.remove(), 4200);
}

async function request(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options?.body ? { "content-type": "application/json" } : {}),
      ...options?.headers,
    },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status}).`);
  return result;
}

function setMode(health) {
  mode = health.mode;
  const text = mode === "demo" ? "Demo mode" : mode === "live" ? "Live monitoring" : "Setup needed";
  refs.modePill.className = `connection-pill ${mode === "demo" ? "is-demo" : mode === "live" ? "is-live" : ""}`;
  refs.modePill.querySelector("span:last-child").textContent = text;
  refs.connectionLabel.textContent =
    mode === "demo" ? "Local demo · no email sent" : mode === "live" ? "Services connected" : "Credentials needed";
  if (mode === "setup") {
    refs.runStatus.textContent = `Add ${health.missing.join(", ")}`;
    refs.runStatus.classList.add("has-error");
    refs.checkButton.disabled = true;
    refs.addButtons.forEach((button) => {
      button.disabled = true;
      button.title = "Configure live credentials to create a live watch.";
    });
  }
  if (mode === "demo") refs.watchStatFoot.textContent = "Sample watch · no real services";
}

function renderWatches(watches) {
  refs.activeCount.textContent = String(watches.filter((watch) => watch.isActive !== false).length);
  refs.watchCount.textContent = String(watches.length);
  refs.watchNavCount.textContent = String(watches.length);
  refs.watchList.replaceChildren();

  if (watches.length === 0) {
    const empty = makeElement("div", "empty-state");
    empty.append(
      makeElement("span", "empty-orbit", "◎"),
      makeElement("strong", "", "Your radar is nice and quiet."),
      makeElement("span", "", "Add a watch and we’ll keep an eye out for a real change."),
    );
    refs.watchList.append(empty);
    return;
  }

  for (const watch of watches) {
    const row = makeElement("article", "watch-row");
    const icon = makeElement("span", `watch-type-icon ${watch.kind.replaceAll("_", "-")}`, kindIcons[watch.kind] ?? "◎");
    icon.setAttribute("aria-hidden", "true");
    const info = makeElement("div", "watch-info");
    info.append(
      makeElement("strong", "watch-name", watch.name),
      makeElement("span", "watch-state"),
    );
    const detail = info.querySelector(".watch-state");
    const current = watch.currentState;
    const stateText = current
      ? formatObservationValue(current.value)
      : watch.kind === "price_drop"
        ? `Watching for a drop to ${formatTargetPrice(watch.criteria)} · baseline pending`
        : `Watching for ${watch.criteria?.alertStatuses?.join(", ") || "a qualifying update"} · baseline pending`;
    detail.append(
      makeElement("span", "watch-indicator"),
      document.createTextNode(" "),
      makeElement("strong", "", stateText),
    );
    const next = makeElement("div", "watch-next");
    next.append(
      makeElement("span", "", watch.lastCheckedAt ? `Checked ${formatTime(watch.lastCheckedAt)}` : "Baseline pending"),
      makeElement("strong", "", formatNextCheck(watch.nextCheckAt, watch.isActive)),
    );
    row.append(icon, info, next);
    refs.watchList.append(row);
  }
}

function formatObservationValue(value) {
  if (typeof value === "string") return value;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: value.currency,
  }).format(value.amount);
}

function formatTargetPrice(criteria = {}) {
  const amount = Number(criteria.targetPrice);
  if (!Number.isFinite(amount)) return "—";
  const currency = criteria.targetCurrency ?? "USD";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amount);
}

function renderActivity(events) {
  refs.activityList.replaceChildren();
  if (events.length === 0) {
    const empty = makeElement("div", "empty-state");
    empty.append(
      makeElement("span", "empty-orbit", "✳"),
      makeElement("strong", "", "All quiet, as it should be."),
      makeElement("span", "", "When a watch changes, you’ll see what happened and the source we found."),
    );
    refs.activityList.append(empty);
    return;
  }

  for (const event of events) {
    const entry = makeElement("article", "activity-entry");
    const sent = event.alertStatus === "sent";
    const icon = makeElement("span", `activity-icon${sent ? " alert" : ""}`, sent ? "↗" : "✓");
    const content = makeElement("div", "activity-content");
    const title = sent ? `${event.watchName} changed` : `${event.watchName} checked`;
    content.append(
      makeElement("div", "activity-title", title),
      makeElement("div", "activity-detail", event.summary || event.state?.summary || ""),
    );
    const meta = makeElement("div", "activity-meta");
    let source;
    try {
      const sourceUrl = new URL(event.sourceUrl);
      if (sourceUrl.protocol !== "https:" && sourceUrl.protocol !== "http:") {
        throw new Error("Unsupported URL protocol.");
      }
      source = makeElement("a", "", event.sourceTitle || "View source");
      source.href = sourceUrl.href;
      source.target = "_blank";
      source.rel = "noopener noreferrer";
      source.title = sourceUrl.href;
    } catch {
      source = makeElement("span", "", event.sourceTitle || "Source unavailable");
    }
    meta.append(
      source,
      makeElement("span", "activity-time", formatTime(event.observedAt ?? event.createdAt)),
    );
    content.append(meta);
    entry.append(icon, content);
    refs.activityList.append(entry);
  }
}

function renderWorkflow(run) {
  const steps = [...document.querySelectorAll(".workflow-step")];
  const connectors = [...document.querySelectorAll(".workflow-connector")];
  steps.forEach((step) => step.classList.remove("is-active", "is-done", "is-failed"));
  connectors.forEach((connector) => connector.classList.remove("is-done"));
  refs.runStatus.classList.remove("has-alert", "has-error");

  if (!run) {
    refs.runStatus.textContent = "Waiting quietly";
    return;
  }
  if (run.status === "running") {
    steps[0]?.classList.add("is-active");
    refs.runStatus.textContent = "A check is in progress…";
    return;
  }
  if (run.status === "failed") {
    steps[0]?.classList.add("is-failed");
    refs.runStatus.textContent = "Check failed · see server logs";
    refs.runStatus.classList.add("has-error");
    return;
  }
  steps.forEach((step) => step.classList.add("is-done"));
  connectors.forEach((connector) => connector.classList.add("is-done"));
  const output = run.output;
  if (output?.alertsSent > 0) {
    refs.runStatus.textContent = `${output.alertsSent} meaningful change · email sent`;
    refs.runStatus.classList.add("has-alert");
  } else {
    refs.runStatus.textContent = "Checked · no meaningful change";
  }
}

function renderDashboard(dashboard) {
  const watches = dashboard.watches ?? [];
  const activity = dashboard.recentActivity ?? [];
  const runs = dashboard.runs ?? [];
  renderWatches(watches);
  renderActivity(activity);

  const lastChecked = watches
    .map((watch) => watch.lastCheckedAt)
    .filter(Boolean)
    .sort((left, right) => new Date(right) - new Date(left))[0];
  refs.lastCheck.textContent = formatTime(lastChecked, watches.length ? "Waiting for first check" : "No watches yet");
  refs.lastCheckFoot.textContent = lastChecked ? "Just checking, never interrupting" : "Checks run on your schedule";
  quietChecks = Math.max(quietChecks, activity.filter((item) => item.alertStatus !== "sent").length);
  refs.quietCount.textContent = String(quietChecks);

  const latestRun = runs[0];
  if (latestRun && latestRun.id !== lastRenderedRunId) {
    lastRenderedRunId = latestRun.id;
    renderWorkflow(latestRun);
  } else if (latestRun) {
    renderWorkflow(latestRun);
  }

  if (latestRun?.status === "running") {
    clearTimeout(runPollTimer);
    runPollTimer = setTimeout(refreshDashboard, 900);
  }
}

async function refreshDashboard() {
  try {
    const dashboard = await request("/api/dashboard");
    renderDashboard(dashboard);
  } catch (error) {
    showToast(`Could not refresh the watchlist: ${error.message}`, true);
  }
}

async function initialize() {
  try {
    const health = await request("/api/health");
    setMode(health);
    const dashboard = await request("/api/dashboard");
    renderDashboard(dashboard);
  } catch (error) {
    setMode({ mode: "setup", missing: [] });
    refs.runStatus.textContent = "QuietWatcher server is unavailable";
    showToast(error.message, true);
  }
}

function openWatchDialog() {
  refs.formError.classList.add("hidden");
  refs.dialog.showModal();
  refs.form.elements.name.focus();
}

async function checkNow() {
  if (requestBusy) return;
  requestBusy = true;
  refs.checkButton.disabled = true;
  refs.checkButton.querySelector(".refresh-icon").textContent = "…";
  renderWorkflow({ status: "running" });
  try {
    const run = await request("/api/check", {
      method: "POST",
      body: JSON.stringify({}),
    });
    showToast(mode === "demo" ? "Demo check started. No real email will be sent." : "Check started. We’ll only email if something changed.");
    await refreshDashboard();
    let completed = false;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 900));
      const dashboard = await request("/api/dashboard");
      renderDashboard(dashboard);
      const latest = dashboard.runs?.find((item) => item.id === run.id);
      if (latest && latest.status !== "running") {
        completed = true;
        if (latest.status === "failed") {
          showToast(`Check failed: ${latest.error ?? "See server logs for details."}`, true);
        } else if (latest.output?.alertsSent > 0) {
          showToast("A meaningful change was found and an alert was sent.");
        } else {
          showToast("Check complete. Nothing meaningfully changed.");
        }
        break;
      }
    }
    if (!completed) showToast("The check is still running. Its status will update when it finishes.");
  } catch (error) {
    renderWorkflow({ status: "failed" });
    showToast(`Could not start a check: ${error.message}`, true);
  } finally {
    requestBusy = false;
    refs.checkButton.disabled = false;
    refs.checkButton.querySelector(".refresh-icon").textContent = "↻";
    await refreshDashboard();
  }
}

function updateKindFields() {
  const price = refs.watchKind.value === "price_drop";
  refs.targetPriceField.classList.toggle("hidden", !price);
  refs.alertStatusesField.classList.toggle("hidden", price);
  refs.form.elements.targetPrice.required = price;
}

async function createWatch(event) {
  event.preventDefault();
  const data = new FormData(refs.form);
  const kind = String(data.get("kind"));
  const payload = {
    name: String(data.get("name")).trim(),
    kind,
    query: String(data.get("query")).trim(),
    recipientEmail: String(data.get("recipientEmail")).trim(),
    checkIntervalMinutes: Number(data.get("checkIntervalMinutes")),
  };
  if (kind === "price_drop") {
    payload.targetPrice = Number(data.get("targetPrice"));
    payload.targetCurrency = String(data.get("targetCurrency"));
  } else {
    payload.alertStatuses = String(data.get("alertStatuses"))
      .split(",")
      .map((status) => status.trim())
      .filter(Boolean);
  }
  const submit = refs.form.querySelector('[type="submit"]');
  submit.disabled = true;
  refs.formError.classList.add("hidden");
  try {
    const result = await request("/api/watches", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    refs.dialog.close();
    refs.form.reset();
    updateKindFields();
    const acknowledgement = result.acknowledgementEmail;
    const message =
      acknowledgement?.error ??
      (acknowledgement?.sent
        ? "Watch is on. A confirmation email was sent to quietwatch@agentmail.to."
        : mode === "demo"
          ? "Added in demo mode. No real email was sent."
          : "Added to your watchlist. The first check will set its baseline.");
    showToast(message, Boolean(acknowledgement?.error));
    await refreshDashboard();
  } catch (error) {
    refs.formError.textContent = error.message;
    refs.formError.classList.remove("hidden");
  } finally {
    submit.disabled = false;
  }
}

refs.addButtons.forEach((button) => button.addEventListener("click", openWatchDialog));
refs.checkButton.addEventListener("click", checkNow);
refs.dialogClose.addEventListener("click", () => refs.dialog.close());
document.querySelector("#cancel-watch").addEventListener("click", () => refs.dialog.close());
refs.form.addEventListener("submit", createWatch);
refs.watchKind.addEventListener("change", updateKindFields);
document.querySelector("#see-all-watches").addEventListener("click", () => {
  document.querySelector("#watches").scrollIntoView({ behavior: "smooth", block: "start" });
});
document.querySelectorAll(".nav-link").forEach((link) => {
  link.addEventListener("click", () => {
    document.querySelectorAll(".nav-link").forEach((item) => item.classList.remove("is-active"));
    link.classList.add("is-active");
  });
});

updateKindFields();
initialize();
setInterval(refreshDashboard, 10_000);
