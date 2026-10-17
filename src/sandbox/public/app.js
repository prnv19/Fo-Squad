// Fo Squad sandbox viewer. Renders a SandboxEvent stream (live over SSE, or
// embedded in a saved report) as phones, a behind-the-scenes log and the split.
// Event data is only ever written with textContent / text nodes: persona texts
// are untrusted and include deliberate prompt injection and raw HTML.
(() => {
  "use strict";

  const STAGES = ["planning", "voting", "booked", "claiming", "paying", "settled"];
  const STAGE_LABEL = { planning: "Planning", voting: "Voting", booked: "Booked", claiming: "Claiming", paying: "Paying", settled: "Settled" };
  const GROUP_IDS = new Set(["all", "group", "everyone"]);
  const AVATAR_COLORS = ["#2563eb", "#db2777", "#0d9488", "#7c3aed", "#ea580c", "#16a34a", "#0891b2", "#c026d3", "#b45309"];
  const FILTERS = [
    { key: "tool", label: "Tools", color: "var(--accent)", on: true },
    { key: "search", label: "Searches", color: "var(--purple)", on: true },
    { key: "scheduled", label: "Timers", color: "var(--warn)", on: true },
    { key: "stage", label: "Stages", color: "var(--success)", on: true },
    { key: "stubbed", label: "Stubbed", color: "var(--stub)", on: true },
    { key: "note", label: "Notes", color: "var(--text-3)", on: true },
    { key: "error", label: "Errors", color: "var(--danger)", on: true },
    { key: "clock", label: "Clock", color: "var(--text-3)", on: true },
    { key: "text", label: "Texts", color: "var(--teal)", on: false },
  ];
  const RELATED_WINDOW_MS = 60_000;

  const $ = (id) => document.getElementById(id);
  const ui = {
    scenario: $("scenario"), clock: $("clock"), stages: $("stages"), status: $("status"), cost: $("cost"),
    follow: $("follow"), followWrap: $("follow-wrap"), play: $("play"), playLabel: $("play-label"),
    stepBack: $("step-back"), stepForward: $("step-forward"), speed: $("speed"), scrub: $("scrub"),
    position: $("position"), pending: $("pending"), conn: $("conn"), toggleSide: $("toggle-side"),
    layout: $("layout"), phones: $("phones"), empty: $("empty"), split: $("split"), splitBody: $("split-body"),
    splitFoot: $("split-foot"), splitTitle: $("split-title"), splitSummary: $("split-summary"),
    splitToggle: $("split-toggle"), splitScroll: $("split-scroll"), filters: $("filters"), log: $("log"),
  };

  // ---------- DOM helper (text only, never HTML) ----------

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = String(value);
        else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? "" : String(value));
      }
    }
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      node.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  // Long pay links swamp a phone-width bubble, so show a short form and keep
  // the full URL in the tooltip. Built from text nodes; never parsed as HTML.
  const URL_RE = /https?:\/\/[^\s<>"]+/g;
  function textWithLinks(text) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(URL_RE)) {
      const url = match[0];
      if (match.index > last) frag.append(document.createTextNode(text.slice(last, match.index)));
      const short = url.replace(/^https?:\/\/(www\.)?/, "");
      frag.append(h("span", { class: "link", title: url, text: truncate(short, 26) }));
      last = match.index + url.length;
    }
    if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
    return frag;
  }

  function truncate(text, max) {
    const s = String(text);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  // ---------- Simulated time ----------

  // An explicit offset means the engine wrote the sim's local wall clock, so we
  // show it as written. "Z" uses run_started.timeZone when the engine sends one
  // (not in the contract yet), else the browser's zone.
  let simTimeZone;
  function parseTime(iso) {
    if (typeof iso !== "string") return null;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?([+-]\d{2}:?\d{2})$/.exec(iso);
    if (m) return { ms, date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))), timeZone: "UTC" };
    return { ms, date: new Date(ms), timeZone: /z$/i.test(iso) ? simTimeZone : undefined };
  }

  function isTimeZone(tz) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
  }

  const formatters = new Map();
  function fmt(t, options) {
    const key = JSON.stringify(options) + (t.timeZone || "");
    let f = formatters.get(key);
    if (!f) {
      f = new Intl.DateTimeFormat("en-US", t.timeZone ? { ...options, timeZone: t.timeZone } : options);
      formatters.set(key, f);
    }
    return f.format(t.date);
  }
  const fmtTime = (iso) => { const t = parseTime(iso); return t ? fmt(t, { hour: "numeric", minute: "2-digit" }) : ""; };
  const fmtDay = (iso) => { const t = parseTime(iso); return t ? fmt(t, { weekday: "short", month: "short", day: "numeric" }) : ""; };
  const fmtClock = (iso) => { const t = parseTime(iso); return t ? `${fmtDay(iso)} · ${fmtTime(iso)}` : "--"; };
  const msOf = (iso) => { const t = parseTime(iso); return t ? t.ms : NaN; };

  function fmtDuration(ms) {
    const mins = Math.round(Math.abs(ms) / 60000);
    if (mins < 1) return "under a minute";
    const d = Math.floor(mins / 1440), hr = Math.floor((mins % 1440) / 60), mn = mins % 60;
    return [d && `${d}d`, hr && `${hr}h`, mn && `${mn}m`].filter(Boolean).join(" ");
  }

  // ---------- Tool results ----------

  function toolName(name) {
    const parts = String(name).split(/__|[.:/]/).filter(Boolean);
    return parts[parts.length - 1] || String(name);
  }

  // Engines may pass the raw MCP result, a JSON string, or the parsed object.
  function unwrapResult(result) {
    let r = result;
    if (typeof r === "string") {
      try { r = JSON.parse(r); } catch { return r; }
    }
    if (r && typeof r === "object" && !Array.isArray(r)) {
      if (r.structuredContent && typeof r.structuredContent === "object") return r.structuredContent;
      if (Array.isArray(r.content)) {
        const text = r.content.find((c) => c && c.type === "text" && typeof c.text === "string");
        if (text) {
          try { return JSON.parse(text.text); } catch { return text.text; }
        }
      }
    }
    return r;
  }

  function errorMessage(res) {
    if (!res || typeof res !== "object") return typeof res === "string" ? res : "";
    if (res.error && typeof res.error === "object") return [res.error.code, res.error.message].filter(Boolean).join(": ");
    if (typeof res.error === "string") return res.error;
    return typeof res.message === "string" ? res.message : "";
  }

  function shortValue(v) {
    if (v === null || v === undefined) return String(v);
    if (typeof v === "string") return JSON.stringify(truncate(v, 30));
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) {
      if (v.length <= 4 && v.every((x) => typeof x === "string" || typeof x === "number")) return `[${truncate(v.join(", "), 32)}]`;
      return `[${v.length} items]`;
    }
    if (typeof v === "object") {
      const keys = Object.keys(v);
      if (typeof v.name === "string") return `{${truncate(v.name, 24)}}`;
      return `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}`;
    }
    return String(v);
  }

  function shortArgs(args) {
    if (args === null || args === undefined) return "";
    if (typeof args !== "object" || Array.isArray(args)) return truncate(shortValue(args), 120);
    const parts = Object.entries(args)
      .filter(([k]) => k !== "event_id")
      .map(([k, v]) => `${k}: ${shortValue(v)}`);
    return truncate(parts.join(", "), 120);
  }

  function pretty(value) {
    if (typeof value === "string") return value;
    try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
  }

  // ---------- State ----------

  const state = {
    events: [],
    applied: 0,
    mode: "live",
    follow: true,
    playing: false,
    timer: 0,
    speed: 1,
    streamDone: false,
    flushQueued: false,
    filters: loadFilters(),
    view: freshView(),
  };

  function freshView() {
    return {
      people: new Map(),
      phones: new Map(),
      bubbles: [],
      entries: [],
      stage: null,
      clockIso: null,
      clockMs: NaN,
      split: null,
      payments: new Map(),
      flashIds: new Set(),
      restaurantName: null,
      selected: null,
      touched: new Set(),
      started: false,
    };
  }

  function loadFilters() {
    const defaults = Object.fromEntries(FILTERS.map((f) => [f.key, f.on]));
    try {
      const saved = JSON.parse(localStorage.getItem("fo-sandbox-filters") || "{}");
      for (const f of FILTERS) if (typeof saved[f.key] === "boolean") defaults[f.key] = saved[f.key];
    } catch { /* storage unavailable (file:// in some browsers) */ }
    return defaults;
  }

  function saveFilters() {
    try { localStorage.setItem("fo-sandbox-filters", JSON.stringify(state.filters)); } catch { /* ignore */ }
  }

  // ---------- View reset ----------

  function resetView() {
    state.view = freshView();
    simTimeZone = undefined;
    ui.phones.replaceChildren(ui.empty);
    ui.empty.hidden = false;
    ui.log.replaceChildren();
    ui.split.hidden = true;
    ui.splitBody.replaceChildren();
    ui.splitFoot.replaceChildren();
    ui.scenario.textContent = "Waiting for a run";
    document.title = "Fo Squad Sandbox";
    ui.clock.textContent = "--";
    setStatus("waiting", "Waiting");
    ui.cost.hidden = true;
    ui.cost.textContent = "";
    renderStages();
  }

  function setStatus(kind, label, title) {
    ui.status.className = `badge badge-${kind}`;
    ui.status.textContent = label;
    if (title) ui.status.title = title;
    else ui.status.removeAttribute("title");
  }

  function renderStages() {
    const current = STAGES.indexOf(state.view.stage);
    for (const li of ui.stages.children) {
      const i = STAGES.indexOf(li.dataset.stage);
      li.classList.toggle("done", current >= 0 && (i < current || (i === current && li.dataset.stage === "settled")));
      li.classList.toggle("current", i === current && li.dataset.stage !== "settled");
      if (i === current) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    }
  }

  // ---------- Phones ----------

  function displayName(id) {
    if (id === "fo") return "Fo";
    if (id === "restaurant") return state.view.restaurantName || "Restaurant";
    const person = state.view.people.get(id);
    if (person) return person.name;
    const s = String(id);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function colorFor(id) {
    let hash = 0;
    for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
  }

  function ensurePhone(id) {
    const existing = state.view.phones.get(id);
    if (existing) return existing;
    ui.empty.hidden = true;

    const isRestaurant = id === "restaurant";
    const person = state.view.people.get(id);
    const role = isRestaurant ? "restaurant" : person ? person.role : "other";
    const name = displayName(id);

    const avatar = h("div", { class: "avatar", "aria-hidden": "true", text: isRestaurant ? "R" : name.charAt(0).toUpperCase() });
    if (!isRestaurant) avatar.style.setProperty("--avatar", colorFor(id));
    const nameEl = h("div", { class: "phone-name" }, name);
    const roleText = isRestaurant ? "Calls and bookings are stubbed" : role === "friend" ? "Friend" : "Unlisted number";
    const roleEl = role === "organizer"
      ? h("div", { class: "phone-role" }, h("span", { class: "role-pill flush", text: "Organizer" }))
      : h("div", { class: "phone-role", text: roleText });
    const count = h("span", { class: "phone-count" });
    const thread = h("div", { class: "thread", role: "log", "aria-label": `${name}: texts with Fo` },
      h("p", { class: "thread-empty", text: isRestaurant ? "Nothing booked yet" : "No texts yet" }));
    const root = h("section", { class: `phone${isRestaurant ? " restaurant" : ""}`, "data-phone": id },
      h("header", { class: "phone-head" }, avatar, h("div", { class: "phone-who" }, nameEl, roleEl), count),
      thread);

    // Organizer first, friends in order, restaurant always last.
    const restaurant = state.view.phones.get("restaurant");
    if (!isRestaurant && restaurant) ui.phones.insertBefore(root, restaurant.root);
    else ui.phones.append(root);

    const phone = { id, root, thread, count, nameEl, items: 0, lastMs: NaN, lastDay: "" };
    state.view.phones.set(id, phone);
    return phone;
  }

  function addToThread(phone, node, iso, animate) {
    if (phone.items === 0) phone.thread.replaceChildren();
    const ms = msOf(iso);
    const day = fmtDay(iso);
    if (day && (day !== phone.lastDay || ms - phone.lastMs >= 45 * 60_000)) {
      phone.thread.append(h("div", { class: "divider", text: `${day} at ${fmtTime(iso)}` }));
    }
    phone.lastDay = day || phone.lastDay;
    phone.lastMs = Number.isNaN(ms) ? phone.lastMs : ms;
    phone.items += 1;
    if (animate) node.classList.add("animate");
    phone.thread.append(node);
    state.view.touched.add(phone);
    if (animate) buzz(phone);
  }

  function updateCount(phone, texts) {
    phone.texts = (phone.texts || 0) + texts;
    phone.count.textContent = phone.texts ? `${phone.texts} text${phone.texts === 1 ? "" : "s"}` : "";
  }

  function buzz(phone) {
    phone.root.classList.add("buzz");
    clearTimeout(phone.buzzTimer);
    phone.buzzTimer = setTimeout(() => phone.root.classList.remove("buzz"), 900);
    phone.root.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }

  function addBubble(phoneId, ev, side, animate) {
    const phone = ensurePhone(phoneId);
    const ms = msOf(ev.at);
    const meta = side === "fo" ? `Fo · ${fmtTime(ev.at)}` : fmtTime(ev.at);
    const bubble = h("div", { class: "bubble", tabindex: "0", role: "button", "aria-label": `${side === "fo" ? "Fo" : displayName(ev.from)}: ${ev.text}` }, textWithLinks(String(ev.text ?? "")));
    const node = h("div", { class: `msg ${side === "fo" ? "from-fo" : "from-them"}` }, bubble, h("div", { class: "msg-meta", text: meta }));
    const select = () => selectFrom(node, ms, "bubble");
    bubble.addEventListener("click", select);
    bubble.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); } });
    addToThread(phone, node, ev.at, animate);
    updateCount(phone, 1);
    state.view.bubbles.push({ node, ms });
  }

  function renderText(ev, animate) {
    const from = String(ev.from), to = String(ev.to);
    if (from !== "fo" && from !== "restaurant") state.view.lastPersonPhone = from;
    if (from === "fo" && GROUP_IDS.has(to.toLowerCase())) {
      for (const id of state.view.people.keys()) addBubble(id, ev, "fo", animate);
    } else if (from === "fo") addBubble(to, ev, "fo", animate);
    else if (to === "fo") addBubble(from, ev, "them", animate);
    else addBubble(to, ev, "them", animate); // neither side is Fo: show on the recipient's phone
  }

  function humanize(action) {
    const s = String(action ?? "").replace(/_/g, " ").trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // Payments belong on the payer's phone (the engine emits them right after
  // the friend's "Paid!"); calls and bookings go to the restaurant column.
  function stubPhoneId(ev) {
    const last = state.view.lastPersonPhone;
    return /pay|venmo/i.test(String(ev.action ?? "")) && last ? last : "restaurant";
  }

  function renderStub(ev, animate) {
    const phone = ensurePhone(stubPhoneId(ev));
    const ms = msOf(ev.at);
    const card = h("div", { class: "stub", tabindex: "0", role: "button" },
      h("div", { class: "stub-tag", text: "Sandbox — not placed" }),
      h("div", { class: "stub-action", text: humanize(ev.action) }),
      ev.detail ? h("div", { class: "stub-detail", text: String(ev.detail) }) : null,
      h("div", { class: "msg-meta", text: fmtTime(ev.at) }));
    const select = () => selectFrom(card, ms, "bubble");
    card.addEventListener("click", select);
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); } });
    addToThread(phone, card, ev.at, animate);
    state.view.bubbles.push({ node: card, ms });
  }

  // ---------- Log ----------

  function addEntry(opts) {
    const { ev, kind, filter, label, title, titleCode, sub, subMono, err, pill, details, extraClass } = opts;
    const ms = msOf(ev.at);
    const main = h("div", null,
      h("div", { class: "entry-kind", text: label }),
      h("div", { class: "entry-title" }, titleCode ? h("code", { text: titleCode }) : null, title ? String(title) : null),
      sub ? h("div", { class: `entry-sub${subMono ? " mono" : ""}`, text: sub }) : null,
      err ? h("div", { class: "entry-err", text: err }) : null);
    const pillEl = pill ? h("span", { class: `pill pill-${pill === "ok" ? "ok" : "err"}`, text: pill === "ok" ? "ok" : "error" }) : h("span");
    const timeEl = h("span", { class: "entry-time", text: fmtTime(ev.at) });

    const li = h("li", { class: `entry k-${kind}${extraClass ? " " + extraClass : ""}`, "data-filter": filter });
    const clickable = kind !== "clock";
    const row = clickable
      ? h("button", { type: "button", class: "entry-row" }, timeEl, main, pillEl)
      : h("div", { class: "entry-row" }, timeEl, main, pillEl);
    li.append(row);

    let detailsEl = null;
    if (details) {
      row.setAttribute("aria-expanded", "false");
      detailsEl = h("div", { class: "entry-details", hidden: true });
      for (const [heading, value] of details) {
        detailsEl.append(h("h3", { text: heading }), h("pre", { text: pretty(value) }));
      }
      li.append(detailsEl);
    }
    if (clickable) {
      row.addEventListener("click", () => {
        const wasSelected = state.view.selected === li;
        if (detailsEl) {
          detailsEl.hidden = wasSelected;
          row.setAttribute("aria-expanded", String(!wasSelected));
        }
        selectFrom(li, ms, "entry");
      });
    }
    if (filter !== "run" && !state.filters[filter]) li.classList.add("hidden");
    ui.log.append(li);
    state.view.entries.push({ node: li, ms, filter });
    return li;
  }

  function clearSelection() {
    for (const n of document.querySelectorAll(".related, .selected")) n.classList.remove("related", "selected");
  }

  // Clicking a log row lights up texts at the same simulated time, and vice versa.
  function selectFrom(node, ms, source) {
    const view = state.view;
    const same = view.selected === node;
    clearSelection();
    if (same) {
      view.selected = null;
      return;
    }
    // Collapse the previously expanded row so only one is open.
    if (view.selected && view.selected.classList.contains("entry")) {
      const prevDetails = view.selected.querySelector(".entry-details");
      if (prevDetails) {
        prevDetails.hidden = true;
        view.selected.querySelector(".entry-row").setAttribute("aria-expanded", "false");
      }
    }
    view.selected = node;
    if (Number.isNaN(ms)) return;
    if (source === "entry") {
      node.classList.add("selected");
      const firstPerPhone = new Set();
      for (const b of view.bubbles) {
        if (Math.abs(b.ms - ms) > RELATED_WINDOW_MS) continue;
        b.node.classList.add("related");
        const thread = b.node.closest(".thread");
        if (thread && !firstPerPhone.has(thread)) {
          firstPerPhone.add(thread);
          b.node.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
        }
      }
    } else {
      node.classList.add("related");
      let first = true;
      for (const e of view.entries) {
        if (Math.abs(e.ms - ms) > RELATED_WINDOW_MS || e.node.classList.contains("hidden")) continue;
        e.node.classList.add("related");
        if (first) e.node.scrollIntoView({ block: "nearest", behavior: "smooth" });
        first = false;
      }
    }
  }

  function applyFilters() {
    for (const e of state.view.entries) {
      e.node.classList.toggle("hidden", e.filter !== "run" && !state.filters[e.filter]);
    }
  }

  function buildFilters() {
    for (const f of FILTERS) {
      const input = h("input", { type: "checkbox" });
      input.checked = !!state.filters[f.key];
      input.addEventListener("change", () => {
        state.filters[f.key] = input.checked;
        saveFilters();
        applyFilters();
      });
      const span = h("span", { text: f.label });
      span.style.setProperty("--c", f.color);
      ui.filters.append(h("label", { class: "filter" }, input, span));
    }
  }

  // ---------- Split table ----------

  function personKey(share) {
    return String(share.person_id ?? share.name ?? "");
  }

  function onCalculateShares(res) {
    if (!res || !Array.isArray(res.shares)) return;
    const view = state.view;
    const previous = view.split ? new Map(view.split.shares.map((s) => [personKey(s), s])) : new Map();
    view.split = { shares: res.shares, total: res.total, totalCents: res.total_cents };
    for (const share of res.shares) {
      const key = personKey(share);
      if (share.is_organizer) continue;
      const prev = previous.get(key);
      // Same rule as the server: an unchanged amount keeps its status, a changed one starts over.
      if (!prev || prev.total_cents !== share.total_cents || !view.payments.has(key)) view.payments.set(key, "pending");
    }
  }

  function onMarkPaid(res) {
    const view = state.view;
    if (!res || !view.split) return;
    const byName = new Map(view.split.shares.map((s) => [String(s.name ?? "").toLowerCase(), personKey(s)]));
    const set = (key, status) => {
      if (!key || !status) return;
      if (view.payments.get(key) !== status) view.flashIds.add(key);
      view.payments.set(key, status);
    };
    const person = res.person && typeof res.person === "object" ? res.person : null;
    if (person) set(String(person.id ?? byName.get(String(person.name ?? "").toLowerCase()) ?? ""), res.status);
    if (Array.isArray(res.still_owing)) {
      const owing = new Map(res.still_owing.map((o) => [byName.get(String(o.name ?? "").toLowerCase()), o.status]));
      for (const share of view.split.shares) {
        if (share.is_organizer) continue;
        const key = personKey(share);
        set(key, owing.has(key) ? owing.get(key) : "paid");
      }
    }
  }

  const PAY_LABEL = { pending: "Pending", says_paid: "Says paid, unconfirmed", paid: "Paid", organizer: "Paid the bill" };

  function money(cents, fallback) {
    if (typeof fallback === "string" && fallback) return fallback;
    if (typeof cents !== "number") return "";
    const sign = cents < 0 ? "-" : "";
    return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
  }

  function renderSplit() {
    const view = state.view;
    if (!view.split) {
      ui.split.hidden = true;
      return;
    }
    ui.split.hidden = false;
    ui.splitTitle.textContent = view.restaurantName ? `The split — ${view.restaurantName}` : "The split";
    const rows = [];
    let paid = 0, says = 0, owing = 0, sub = 0, extras = 0, total = 0;
    for (const share of view.split.shares) {
      const key = personKey(share);
      const status = share.is_organizer ? "organizer" : view.payments.get(key) || "pending";
      if (status === "paid") paid += 1;
      if (status === "says_paid") says += 1;
      if (!share.is_organizer) owing += 1;
      sub += Number(share.subtotal_cents) || 0;
      extras += (Number(share.extras_cents) || 0) + (Number(share.treat_cents) || 0);
      total += Number(share.total_cents) || 0;
      const items = Array.isArray(share.items)
        ? share.items.map((i) => (i.fraction && i.fraction !== "1" ? `${i.fraction} ${i.description}` : String(i.description ?? ""))).join(", ")
        : "";
      const tr = h("tr", null,
        h("td", { class: "person" }, String(share.name ?? key), share.is_organizer ? h("span", { class: "role-pill", text: "Organizer" }) : null),
        h("td", { class: "items", text: items }),
        h("td", { class: "num", text: money(share.subtotal_cents, share.subtotal) }),
        h("td", { class: "num", text: money((Number(share.extras_cents) || 0) + (Number(share.treat_cents) || 0)) }),
        h("td", { class: "num total", text: money(share.total_cents, share.total) }),
        h("td", null, h("span", { class: `pay pay-${status}`, text: PAY_LABEL[status] || String(status) })));
      if (view.flashIds.has(key)) tr.classList.add("flash");
      rows.push(tr);
    }
    view.flashIds.clear();
    ui.splitBody.replaceChildren(...rows);
    ui.splitFoot.replaceChildren(h("tr", null,
      h("td", { text: "Total" }), h("td"),
      h("td", { class: "num", text: money(sub) }),
      h("td", { class: "num", text: money(extras) }),
      h("td", { class: "num", text: money(view.split.totalCents ?? total, view.split.total) }),
      h("td")));
    const parts = [`${paid} of ${owing} paid`];
    if (says) parts.push(`${says} says paid`);
    if (view.stage === "settled") parts.push("settled");
    ui.splitSummary.textContent = parts.join(" · ");
  }

  // ---------- Applying events ----------

  function advanceClock(iso) {
    const ms = msOf(iso);
    if (Number.isNaN(ms) || ms < state.view.clockMs) return;
    state.view.clockMs = ms;
    state.view.clockIso = iso;
    ui.clock.textContent = fmtClock(iso);
  }

  function apply(ev, animate) {
    if (!ev || typeof ev !== "object") return;
    const view = state.view;
    const prevClockMs = view.clockMs;
    advanceClock(ev.at);

    switch (ev.type) {
      case "run_started": {
        if (view.started) {
          // A second run on the same stream: start the phones over, keep the log.
          const keepLog = [...ui.log.children];
          resetView();
          ui.log.replaceChildren(...keepLog);
          advanceClock(ev.at);
        }
        state.view.started = true;
        simTimeZone = typeof ev.timeZone === "string" && isTimeZone(ev.timeZone) ? ev.timeZone : undefined;
        ui.scenario.textContent = String(ev.scenario ?? "Sandbox run");
        document.title = `${ev.scenario} — Fo Squad Sandbox`;
        setStatus("running", "Running");
        const people = Array.isArray(ev.people) ? ev.people : [];
        const ordered = [...people.filter((p) => p.role === "organizer"), ...people.filter((p) => p.role !== "organizer")];
        for (const p of ordered) state.view.people.set(String(p.id), { name: String(p.name ?? p.id), role: p.role });
        for (const p of ordered) ensurePhone(String(p.id));
        ensurePhone("restaurant");
        addEntry({ ev, kind: "run", filter: "run", label: "Run started", title: String(ev.scenario ?? ""),
          sub: ordered.map((p) => `${p.name}${p.role === "organizer" ? " (organizer)" : ""}`).join(", ") });
        break;
      }
      case "clock": {
        const delta = Number.isNaN(prevClockMs) ? NaN : msOf(ev.at) - prevClockMs;
        // Small ticks are noise in the log; the top bar clock still shows them.
        if (!(delta >= 30 * 60_000)) break;
        addEntry({ ev, kind: "clock", filter: "clock", label: "Clock",
          title: `Clock +${fmtDuration(delta)} \u2192 ${fmtClock(ev.at)}` });
        break;
      }
      case "text": {
        renderText(ev, animate);
        addEntry({ ev, kind: "text", filter: "text", label: "Text", title: `${displayName(ev.from)} → ${displayName(ev.to)}`, sub: truncate(ev.text ?? "", 160) });
        break;
      }
      case "tool": {
        const name = toolName(ev.name);
        const res = unwrapResult(ev.result);
        const ok = ev.ok !== false && !(res && typeof res === "object" && res.ok === false);
        addEntry({ ev, kind: ok ? "tool" : "tool-err", filter: "tool", label: "Tool call", titleCode: name,
          sub: shortArgs(ev.args), subMono: true, err: ok ? "" : errorMessage(res) || "Failed",
          pill: ok ? "ok" : "err", details: [["Arguments", ev.args ?? null], ["Result", res ?? null]] });
        if (ok && name === "confirm_booking" && ev.args && typeof ev.args.restaurant_name === "string") {
          view.restaurantName = ev.args.restaurant_name;
          const rest = view.phones.get("restaurant");
          if (rest) rest.nameEl.textContent = view.restaurantName;
        }
        if (ok && name === "calculate_shares") onCalculateShares(res);
        if (ok && name === "mark_paid") onMarkPaid(res);
        if (ok && res && typeof res.stage === "string" && STAGES.includes(res.stage.toLowerCase()) && !view.stage) {
          view.stage = res.stage.toLowerCase();
          renderStages();
        }
        break;
      }
      case "stubbed": {
        renderStub(ev, animate);
        addEntry({ ev, kind: "stubbed", filter: "stubbed", label: "Stubbed, not performed", title: humanize(ev.action), sub: String(ev.detail ?? "") });
        break;
      }
      case "search": {
        const count = typeof ev.resultCount === "number" ? `${ev.resultCount} result${ev.resultCount === 1 ? "" : "s"}` : "";
        addEntry({ ev, kind: "search", filter: "search", label: "Web search", title: `“${ev.query ?? ""}”`, sub: count });
        break;
      }
      case "scheduled": {
        const delta = msOf(ev.runAt) - msOf(ev.at);
        const when = fmtClock(ev.runAt);
        addEntry({ ev, kind: "scheduled", filter: "scheduled", label: "Timer scheduled", title: String(ev.description ?? ""),
          sub: Number.isNaN(delta) ? `Fires ${ev.runAt}` : `Fires ${when} (in ${fmtDuration(delta)})` });
        break;
      }
      case "stage": {
        const stage = String(ev.stage ?? "").toLowerCase();
        if (STAGES.includes(stage)) {
          view.stage = stage;
          renderStages();
        }
        addEntry({ ev, kind: "stage", filter: "stage", label: "Stage", title: STAGE_LABEL[stage] || String(ev.stage ?? ""), sub: ev.eventId ? `Event ${ev.eventId}` : "" });
        break;
      }
      case "note": {
        addEntry({ ev, kind: "note", filter: "note", label: "Note", title: String(ev.text ?? "") });
        break;
      }
      case "error": {
        addEntry({ ev, kind: "error", filter: "error", label: "Error", title: String(ev.message ?? "") });
        break;
      }
      case "run_finished": {
        state.streamDone = true;
        setStatus(ev.ok ? "finished" : "error", ev.ok ? "Finished" : "Error", String(ev.summary ?? ""));
        const usage = ev.usage && typeof ev.usage === "object" ? ev.usage : null;
        if (usage) {
          const tokens = (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0) + (Number(usage.cacheReadTokens) || 0);
          const tokenText = tokens >= 1000 ? `${Math.round(tokens / 1000)}k tokens` : `${tokens} tokens`;
          ui.cost.textContent = typeof usage.estimatedUsd === "number" ? `Est. $${usage.estimatedUsd.toFixed(2)} · ${tokenText}` : tokenText;
          ui.cost.title = `Input ${usage.inputTokens}, output ${usage.outputTokens}, cache read ${usage.cacheReadTokens}, web searches ${usage.webSearches}`;
          ui.cost.hidden = false;
        }
        addEntry({ ev, kind: "run", filter: "run", label: ev.ok ? "Run finished" : "Run failed", title: String(ev.summary ?? ""),
          extraClass: ev.ok ? "finished" : "failed", details: usage ? [["Usage", usage]] : null });
        break;
      }
      default:
        addEntry({ ev, kind: "note", filter: "note", label: String(ev.type ?? "event"), title: truncate(pretty(ev), 200) });
    }
  }

  function applyUpTo(n, animate) {
    const target = Math.min(n, state.events.length);
    const startedAt = state.applied;
    while (state.applied < target) {
      apply(state.events[state.applied], animate && target - startedAt <= 3);
      state.applied += 1;
    }
    afterRender();
  }

  function seek(n) {
    const target = Math.max(0, Math.min(n, state.events.length));
    if (target < state.applied) {
      resetView();
      state.applied = 0;
    }
    applyUpTo(target, false);
  }

  function afterRender() {
    renderSplit();
    // Keep the newest text and log row on screen while watching.
    for (const phone of state.view.touched) phone.thread.scrollTop = phone.thread.scrollHeight;
    state.view.touched.clear();
    ui.log.scrollTop = ui.log.scrollHeight;
    updateControls();
  }

  // ---------- Playback ----------

  function delayFor(ev) {
    switch (ev && ev.type) {
      case "text": return 700 + Math.min(1600, String(ev.text ?? "").length * 14);
      case "tool": return 450;
      case "search": return 600;
      case "stubbed": return 900;
      case "stage": return 900;
      case "clock": return 450;
      case "error": return 700;
      case "run_finished": return 800;
      default: return 450;
    }
  }

  function setFollow(on) {
    state.follow = on;
    ui.follow.checked = on;
  }

  function play() {
    if (state.applied >= state.events.length) seek(0);
    state.playing = true;
    setFollow(false);
    updateControls();
    scheduleNext();
  }

  function pause() {
    state.playing = false;
    clearTimeout(state.timer);
    updateControls();
  }

  function scheduleNext() {
    clearTimeout(state.timer);
    if (!state.playing) return;
    if (state.applied >= state.events.length) {
      state.playing = false;
      // Caught up with a run that is still going: hand over to live following.
      if (state.mode === "live" && !state.streamDone) setFollow(true);
      updateControls();
      return;
    }
    const next = state.events[state.applied];
    state.timer = setTimeout(() => {
      applyUpTo(state.applied + 1, true);
      scheduleNext();
    }, state.applied === 0 ? 300 : delayFor(next) / state.speed);
  }

  function step(delta) {
    pause();
    setFollow(false);
    if (delta < 0) seek(state.applied - 1);
    else applyUpTo(state.applied + 1, true);
  }

  function updateControls() {
    const total = state.events.length;
    ui.scrub.max = String(total);
    ui.scrub.value = String(state.applied);
    ui.position.textContent = `${state.applied} / ${total}`;
    ui.play.classList.toggle("playing", state.playing);
    ui.playLabel.textContent = state.playing ? "Pause" : state.applied >= total ? "Replay" : "Play";
    ui.play.disabled = total === 0;
    ui.stepBack.disabled = state.applied === 0;
    ui.stepForward.disabled = state.applied >= total;
    const behind = total - state.applied;
    const showPending = state.mode === "live" && !state.follow && !state.playing && behind > 0;
    ui.pending.hidden = !showPending;
    if (showPending) ui.pending.textContent = `${behind} new event${behind === 1 ? "" : "s"}`;
  }

  // ---------- Input ----------

  function ingest(ev) {
    state.events.push(ev);
    if (state.mode === "live" && state.follow && !state.playing) queueFlush();
    else updateControls();
  }

  // History arrives as a burst on connect; batch it into one render per frame.
  function queueFlush() {
    if (state.flushQueued) return;
    state.flushQueued = true;
    requestAnimationFrame(() => {
      state.flushQueued = false;
      if (state.follow && !state.playing) applyUpTo(state.events.length, true);
    });
  }

  function setConn(text, bad) {
    ui.conn.textContent = text;
    ui.conn.classList.toggle("bad", !!bad);
  }

  function connectLive() {
    if (location.protocol === "file:") {
      setConn("No data: open the viewer URL or a saved report", true);
      return;
    }
    const source = new EventSource("events");
    source.onopen = () => {
      // The server replays the whole history on every (re)connect, so start clean.
      pause();
      state.events = [];
      state.applied = 0;
      state.streamDone = false;
      resetView();
      setFollow(true);
      updateControls();
      setConn("Live", false);
    };
    source.onmessage = (message) => {
      let ev;
      try { ev = JSON.parse(message.data); } catch { return; }
      ingest(ev);
      if (ev && ev.type === "run_finished") {
        source.close();
        setConn("Run complete", false);
      }
    };
    source.onerror = () => {
      if (!state.streamDone) setConn("Reconnecting…", true);
    };
  }

  function bindControls() {
    ui.follow.addEventListener("change", () => {
      state.follow = ui.follow.checked;
      if (state.follow) {
        pause();
        applyUpTo(state.events.length, false);
      }
      updateControls();
    });
    ui.play.addEventListener("click", () => (state.playing ? pause() : play()));
    ui.stepBack.addEventListener("click", () => step(-1));
    ui.stepForward.addEventListener("click", () => step(1));
    ui.speed.addEventListener("change", () => {
      state.speed = Number(ui.speed.value) || 1;
      if (state.playing) scheduleNext();
    });
    ui.scrub.addEventListener("input", () => {
      pause();
      setFollow(false);
      seek(Number(ui.scrub.value));
    });
    ui.pending.addEventListener("click", () => {
      setFollow(true);
      applyUpTo(state.events.length, false);
    });
    ui.splitToggle.addEventListener("click", () => {
      const collapsed = ui.split.classList.toggle("collapsed");
      ui.splitScroll.hidden = collapsed;
      ui.splitToggle.textContent = collapsed ? "Show" : "Hide";
      ui.splitToggle.setAttribute("aria-expanded", String(!collapsed));
    });
    ui.toggleSide.addEventListener("click", () => {
      const hidden = ui.layout.classList.toggle("side-hidden");
      ui.toggleSide.setAttribute("aria-pressed", String(!hidden));
    });
    document.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = e.target && e.target.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON" || (e.target && e.target.getAttribute && e.target.getAttribute("role") === "button")) return;
      if (e.key === " " || e.key === "k") { e.preventDefault(); state.playing ? pause() : play(); }
      else if (e.key === "ArrowLeft" || e.key === "j") step(-1);
      else if (e.key === "ArrowRight" || e.key === "l") step(1);
      else if (e.key === "b") ui.toggleSide.click();
      else if (e.key === "f" && state.mode === "live") { ui.follow.checked = !ui.follow.checked; ui.follow.dispatchEvent(new Event("change")); }
    });
    ui.play.title = "Play or pause (Space)";
    ui.toggleSide.title = "Show or hide the log (B)";
  }

  function init() {
    buildFilters();
    bindControls();
    resetView();

    const params = new URLSearchParams(location.search);
    const speed = params.get("speed");
    if (speed && [...ui.speed.options].some((o) => o.value === speed)) {
      ui.speed.value = speed;
      state.speed = Number(speed);
    }
    if (params.get("side") === "0") ui.toggleSide.click();

    const embedded = document.getElementById("sandbox-history");
    if (embedded) {
      // Saved report: the whole run is embedded, so there is nothing to follow.
      state.mode = "report";
      state.streamDone = true;
      ui.followWrap.hidden = true;
      setFollow(false);
      setConn("Saved replay", false);
      let history = [];
      try { history = JSON.parse(embedded.textContent || "[]"); } catch { setConn("Could not read the embedded run", true); }
      state.events = Array.isArray(history) ? history : [];
      // ?replay plays from the start; ?at=N opens at event N (handy for screenshots and bug reports).
      if (params.has("replay")) play();
      else if (params.has("at")) seek(Number(params.get("at")) || 0);
      else applyUpTo(state.events.length, false);
    } else {
      connectLive();
      updateControls();
    }
  }

  init();
})();
