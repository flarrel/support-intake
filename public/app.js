const byId = (id) => document.getElementById(id);

const intake = {
  form: byId("intake-form"),
  textMode: byId("text-mode"),
  imageMode: byId("image-mode"),
  textInput: byId("text-input"),
  imageInput: byId("image-input"),
  text: byId("ticket-text"),
  image: byId("ticket-image"),
  submit: byId("submit-ticket"),
  message: byId("intake-message"),
};

const queue = {
  filter: byId("queue-filter"),
  count: byId("queue-count"),
  message: byId("queue-message"),
  list: byId("ticket-list"),
};

const detail = {
  status: byId("detail-status"),
  message: byId("detail-message"),
  body: byId("ticket-detail"),
  id: byId("detail-id"),
  source: byId("detail-source"),
  intentLabel: byId("detail-intent-label"),
  intent: byId("detail-intent"),
  confidence: byId("detail-confidence"),
  textLabel: byId("detail-text-label"),
  text: byId("detail-text"),
  history: byId("ticket-history"),
  historyEmpty: byId("history-empty"),
};

const review = {
  form: byId("review-form"),
  intent: byId("review-intent"),
  note: byId("review-note"),
  save: byId("save-review"),
  message: byId("review-message"),
};

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const confidenceFormat = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});

let imageMode = false;
let selectedId = null;
let currentTicket = null;
let intents = [];
let queueRequest = 0;
let detailRequest = 0;
let saving = false;

function makeElement(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function showMessage(element, message, isError = false) {
  element.classList.toggle("is-error", isError);
  element.textContent = message;
}

async function request(url, { method = "GET", body } = {}) {
  const options = { method };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null) {
    const error = new Error(data?.error || "The request failed. Please try again.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function formatIntent(intent) {
  if (!intent) return "Unassigned";
  const label = intent.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatSource(source) {
  return source === "image" ? "Screenshot" : "Text";
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : dateFormat.format(date);
}

function setStatus(element, status) {
  element.dataset.status = status;
  element.textContent = status === "review" ? "Needs review" : "Routed";
}

function updateSelection() {
  for (const button of queue.list.querySelectorAll("[data-ticket-id]")) {
    if (button.dataset.ticketId === String(selectedId)) {
      button.setAttribute("aria-current", "true");
    } else {
      button.removeAttribute("aria-current");
    }
  }
}

function renderQueue(tickets) {
  const items = tickets.map((ticket) => {
    const row = makeElement("li");
    const button = makeElement("button", "ticket-item");
    button.type = "button";
    button.dataset.ticketId = ticket.id;
    button.addEventListener("click", () => selectTicket(ticket.id));

    const main = makeElement("span", "item-main");
    const title = makeElement("span", "item-title", formatIntent(ticket.intent));
    const status = makeElement("span", "status");
    setStatus(status, ticket.status);
    main.append(title, status);
    const metadata = [`#${ticket.id}`, formatSource(ticket.source), formatDate(ticket.createdAt)];
    button.append(main, makeElement("span", "item-meta", metadata.filter(Boolean).join(" · ")));
    row.append(button);
    return row;
  });

  queue.list.replaceChildren(...items);
  updateSelection();
  queue.count.textContent = tickets.length;
  queue.count.setAttribute("aria-label", `${tickets.length} tickets shown`);
  queue.count.hidden = false;
  queue.message.hidden = tickets.length > 0;
  showMessage(queue.message, queue.filter.value ? "No tickets match this filter." : "No tickets yet.");
}

async function refreshQueue() {
  const requestId = ++queueRequest;
  const filter = queue.filter.value;
  const path = filter ? `/api/tickets?status=${encodeURIComponent(filter)}` : "/api/tickets";
  try {
    const data = await request(path);
    if (requestId === queueRequest) renderQueue(data.tickets);
  } catch (error) {
    if (requestId !== queueRequest) return;
    queue.count.hidden = true;
    queue.list.replaceChildren();
    queue.message.hidden = false;
    showMessage(queue.message, error.message, true);
  }
}

function renderIntentOptions(ticket) {
  const options = [new Option("Choose an intent", "")];
  for (const intent of intents) options.push(new Option(formatIntent(intent), intent));
  review.intent.replaceChildren(...options);
  review.intent.value = intents.includes(ticket?.intent) ? ticket.intent : "";
  review.save.disabled = !ticket || !intents.length || saving;
}

function renderHistory(history) {
  const items = history.map((event) => {
    const entry = makeElement("li");
    const route = event.fromIntent === event.toIntent
      ? `Confirmed ${formatIntent(event.toIntent)}`
      : `${formatIntent(event.fromIntent)} → ${formatIntent(event.toIntent)}`;
    entry.append(makeElement("p", "history-route", route));
    if (event.note) entry.append(makeElement("p", "history-note", event.note));
    const date = makeElement("time", "history-date", formatDate(event.createdAt));
    date.dateTime = event.createdAt;
    entry.append(date);
    return entry;
  });

  detail.history.replaceChildren(...items);
  detail.historyEmpty.hidden = items.length > 0;
}

function renderDetail(ticket, history) {
  currentTicket = ticket;
  detail.body.hidden = false;
  detail.status.hidden = false;
  detail.message.hidden = true;
  setStatus(detail.status, ticket.status);
  detail.id.textContent = `#${ticket.id}`;
  detail.source.textContent = formatSource(ticket.source);
  detail.intentLabel.textContent = history.length ? "Reviewed intent" : "Suggested intent";
  detail.intent.textContent = formatIntent(ticket.intent);
  detail.confidence.textContent = Number.isFinite(ticket.confidence)
    ? confidenceFormat.format(ticket.confidence)
    : "Unavailable";
  detail.textLabel.textContent = ticket.source === "image" ? "Extracted text" : "Request text";
  detail.text.textContent = ticket.text || "No text detected.";
  renderIntentOptions(ticket);
  renderHistory(history);
}

async function selectTicket(id, { preserveNote = false } = {}) {
  const requestId = ++detailRequest;
  selectedId = id;
  currentTicket = null;
  updateSelection();
  detail.body.hidden = true;
  detail.status.hidden = true;
  detail.message.hidden = false;
  showMessage(detail.message, "Loading ticket…");
  showMessage(review.message, "");
  if (!preserveNote) review.note.value = "";

  try {
    const data = await request(`/api/tickets/${id}`);
    if (requestId !== detailRequest) return false;
    renderDetail(data.ticket, data.history);
    return true;
  } catch (error) {
    if (requestId === detailRequest) showMessage(detail.message, error.message, true);
    return false;
  }
}

async function loadIntents() {
  try {
    const data = await request("/api/intents");
    intents = data.intents;
    renderIntentOptions(currentTicket);
  } catch (error) {
    showMessage(review.message, error.message, true);
  }
}

function setIntakeMode(useImage) {
  imageMode = useImage;
  intake.textMode.setAttribute("aria-pressed", String(!useImage));
  intake.imageMode.setAttribute("aria-pressed", String(useImage));
  intake.textInput.hidden = useImage;
  intake.imageInput.hidden = !useImage;
  intake.text.disabled = useImage;
  intake.image.disabled = !useImage;
  intake.text.required = !useImage;
  intake.image.required = useImage;
  showMessage(intake.message, "");
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(new Error("The screenshot could not be read."));
    reader.readAsDataURL(file);
  });
}

async function inputPayload() {
  if (!imageMode) {
    const text = intake.text.value.trim();
    if (!text) throw new Error("Enter the request text.");
    return { text };
  }

  const file = intake.image.files[0];
  if (!file || !["image/png", "image/jpeg"].includes(file.type)) {
    throw new Error("Choose a PNG or JPEG screenshot.");
  }
  return { image: await readImage(file), mime: file.type };
}

intake.textMode.addEventListener("click", () => setIntakeMode(false));
intake.imageMode.addEventListener("click", () => setIntakeMode(true));
queue.filter.addEventListener("change", refreshQueue);

intake.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (intake.submit.disabled) return;
  intake.submit.disabled = true;
  intake.textMode.disabled = true;
  intake.imageMode.disabled = true;
  showMessage(intake.message, "Submitting…");

  try {
    const body = await inputPayload();
    const { ticket } = await request("/api/tickets", { method: "POST", body });
    intake.form.reset();
    queue.filter.value = "";
    showMessage(intake.message, `Ticket #${ticket.id} submitted.`);
    await Promise.all([refreshQueue(), selectTicket(ticket.id)]);
  } catch (error) {
    showMessage(intake.message, error.message, true);
  } finally {
    intake.submit.disabled = false;
    intake.textMode.disabled = false;
    intake.imageMode.disabled = false;
  }
});

review.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentTicket || saving) return;

  const { id, version } = currentTicket;
  const body = { intent: review.intent.value, note: review.note.value.trim(), version };
  saving = true;
  review.save.disabled = true;
  showMessage(review.message, "Saving…");

  try {
    await request(`/api/tickets/${id}`, { method: "PATCH", body });
    if (selectedId === id && await selectTicket(id)) showMessage(review.message, "Review saved.");
    await refreshQueue();
  } catch (error) {
    if (selectedId !== id) return;
    if (error.status === 409) {
      const loaded = await selectTicket(id, { preserveNote: true });
      if (loaded) showMessage(review.message, "This ticket changed. Check the latest review and try again.", true);
      await refreshQueue();
    } else {
      showMessage(review.message, error.message, true);
    }
  } finally {
    saving = false;
    review.save.disabled = !currentTicket || !intents.length;
  }
});

void refreshQueue();
void loadIntents();
