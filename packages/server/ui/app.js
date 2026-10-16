"use strict";

// zeploy admin UI. Plain browser JavaScript, no build step: the server serves
// this file as is, both to the Electron window and to a browser on this PC.

const token = document.querySelector('meta[name="admin-token"]').content;
// Present only inside the Electron app (see packages/admin/preload.cjs).
const desktop = window.zeployDesktop ?? null;

// After Effects' layer label colors, one per package.
const LABELS = ["#E4D84C", "#A9CBC7", "#677DE0", "#E8920D", "#E5BCC9", "#4AA44C", "#A9A9CA", "#3DA2A5", "#F46DD6", "#E7C19E", "#B3C7B3", "#A89677"];
const APP_SHORT = { aftereffects: "AE", premiere: "Premiere", animate: "Animate" };
const APP_LABELS = { aftereffects: "After Effects", premiere: "Premiere Pro", animate: "Animate", blender: "Blender" };
const TYPE_LABELS = { cep: "CEP panel", "ae-script": "AE script", jsfl: "JSFL command", zxp: "ZXP extension", blender: "Blender add-on" };
const STATUS = { queued: "Queued", sent: "Sent", running: "Running", done: "Done", failed: "Failed" };
const ACTIVE = new Set(["queued", "sent", "running"]);
const FILTERS = [
  { id: "all", label: "All" },
  { id: "updates", label: "Updates" },
  { id: "failed", label: "Failed" },
  { id: "offline", label: "Offline" },
];
const RUN_OPTIONS = [
  { id: "fail", label: "Stop", title: "The job fails with the reason, and nothing on that PC changes", help: "" },
  { id: "kill", label: "Close it", title: "zeploy closes the app before installing", help: "Unsaved work in the app is lost." },
  { id: "ignore", label: "Ignore", title: "Install while the app runs", help: "Restart the app later to load the new version." },
];
const X_ICON =
  '<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path></svg>';
const WARN_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8L15 14H1L8 1.8z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path><path d="M8 6.2v3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path><circle cx="8" cy="11.8" r="0.9" fill="currentColor"></circle></svg>';
const CHECK_ICON =
  '<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 7.5l3 3L11.5 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

let state = null;
const selection = new Map(); // key -> { agentId, packageId }
let tab = "changes";
let filter = "all";
let runMode = "fail";
let openJobId = null;
let openJobLog = [];
let renamingId = null;
// Cells to select once a just-added package shows up in the server's state.
let pendingSelect = null;

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cellKey = (agentId, packageId) => `${agentId}|${packageId}`;
const pcs = (n) => `${n} ${n === 1 ? "PC" : "PCs"}`;
// The name the admin gave a PC, else its Windows computer name.
const nameOf = (agent) => agent.label || agent.hostname;

function listText(items) {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

async function api(method, path, body) {
  const init = { method, headers: { "x-zeploy-admin": token } };
  if (body instanceof Blob) {
    init.body = body;
    init.headers["content-type"] = "application/zip";
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function compareSemver(a, b) {
  const [ca = "", pa] = a.split(/[-+]/, 2);
  const [cb = "", pb] = b.split(/[-+]/, 2);
  const na = ca.split(".").map(Number);
  const nb = cb.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa && !pb) return -1;
  if (!pa && pb) return 1;
  return (pa ?? "").localeCompare(pb ?? "");
}

function labelFor(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return LABELS[h % LABELS.length];
}

function latestPackages() {
  const byId = new Map();
  for (const p of state.packages) {
    const cur = byId.get(p.id);
    if (!cur || compareSemver(p.version, cur.version) > 0) byId.set(p.id, p);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function relTime(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), isError ? 8000 : 3500);
}

async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast("Couldn't copy to the clipboard. Copy it from the screen instead.", true);
  }
}

// Per-viewer conveniences only; the page works without them.
const remember = {
  get(key) {
    try {
      return localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

function agentHasApp(agent, app) {
  const s = agent.state;
  if (!s) return false;
  return app === "blender" ? s.blender.length > 0 : s.adobe.some((a) => a.app === app);
}

function agentApps(agent) {
  const s = agent.state;
  if (!s) return "Apps not reported yet";
  const parts = s.adobe.map((a) => `${APP_SHORT[a.app] ?? a.app} ${a.version}`);
  if (s.blender.length) parts.push(`Blender ${s.blender.join(", ")}`);
  return parts.join(", ") || "No target apps found";
}

function agentDetails(agent) {
  return [
    agent.label ? `${agent.hostname}, ${agent.address}` : agent.address,
    agent.online ? `Online, user ${agent.user}` : `Offline, last seen ${relTime(agent.lastSeen)}`,
    agentApps(agent),
  ].join("\n");
}

function sortedAgents() {
  return [...state.agents].sort((a, b) => b.online - a.online || nameOf(a).localeCompare(nameOf(b)));
}

// A queued job the admin cancelled: the server records it as failed with this error.
const isCancelled = (job) => job.status === "failed" && job.error === "cancelled";

// What a PC has of a package, and what zeploy is doing about it.
function cellInfo(agent, pkg) {
  const receipt = agent.state?.receipts.find((r) => r.id === pkg.id) ?? null;
  const jobs = state.jobs.filter((j) => j.agentId === agent.id && j.packageId === pkg.id && !isCancelled(j));
  const active = jobs.find((j) => ACTIVE.has(j.status));
  const last = jobs.find((j) => !ACTIVE.has(j.status));
  let status;
  if (active) status = active.status === "queued" ? "queued" : "busy";
  else if (last?.status === "failed") status = "failed";
  else if (receipt) status = compareSemver(receipt.version, pkg.version) >= 0 ? "current" : "old";
  else status = "none";
  return { status, receipt, active };
}

function hasStatus(agent, status) {
  return latestPackages().some((p) => cellInfo(agent, p).status === status);
}

function matchesFilter(agent) {
  if (filter === "updates") return hasStatus(agent, "old");
  if (filter === "failed") return hasStatus(agent, "failed");
  if (filter === "offline") return !agent.online;
  return true;
}

// "close After Effects first (or pass --if-running kill ...)" -> the app name.
function parseReason(error) {
  const line = (error ?? "").split("\n")[0];
  const m = /^close (.+?) first\b/i.exec(line);
  return m ? { text: `${m[1]} was open`, app: m[1] } : { text: line, app: null };
}

// ---- rendering --------------------------------------------------------------------------

function renderTop() {
  const total = state.agents.length;
  const online = state.agents.filter((a) => a.online).length;
  const el = $("online");
  el.innerHTML = `<span class="dot${online ? " on" : ""}"></span>${total ? `${online} of ${total} online` : "No PCs yet"}`;
  el.title = state.addresses.length
    ? `Server ${state.addresses.map((a) => `${a}:${state.port}`).join(", ")}`
    : "This computer has no network address";
}

function renderFilters() {
  const el = $("filters");
  el.hidden = state.agents.length === 0;
  const counts = {
    updates: state.agents.filter((a) => hasStatus(a, "old")).length,
    failed: state.agents.filter((a) => hasStatus(a, "failed")).length,
    offline: state.agents.filter((a) => !a.online).length,
  };
  el.innerHTML = FILTERS.map((f) => {
    const n = counts[f.id] ?? 0;
    const count = n ? `<span class="n${f.id === "failed" ? " err" : ""}">${n}</span>` : "";
    return `<button type="button" class="filter" data-filter="${f.id}" aria-pressed="${filter === f.id}">${f.label}${count}</button>`;
  }).join("");
}

function cellHtml(agent, pkg) {
  const { status, receipt, active } = cellInfo(agent, pkg);
  const removing = active?.action === "uninstall";
  const caption = { old: "Update", busy: removing ? "Removing" : "Installing", queued: "Queued", failed: "Failed" }[status] ?? "";
  const words = {
    current: `version ${receipt?.version}, up to date`,
    old: `version ${receipt?.version}, update to ${pkg.version}`,
    none: "not installed",
    busy: removing ? "removing" : "installing",
    queued: "queued",
    failed: `last job failed${receipt ? `, version ${receipt.version} installed` : ""}`,
  }[status];
  const label = `${pkg.name} on ${nameOf(agent)}: ${words}`;
  const pressed = selection.has(cellKey(agent.id, pkg.id));
  return (
    `<td><button type="button" class="cell-btn" data-agent="${esc(agent.id)}" data-pkg="${esc(pkg.id)}" ` +
    `aria-pressed="${pressed}" aria-label="${esc(label)}" title="${esc(label)}" style="--label:${labelFor(pkg.id)}">` +
    `<span class="key ${status}" aria-hidden="true"></span>${caption ? `<span class="cap ${status}">${caption}</span>` : ""}` +
    `</button></td>`
  );
}

function rowHtml(agent, pkgs) {
  const warn =
    agent.online && agent.state && !agent.state.isAdmin
      ? `<span class="warn-icon" role="img" aria-label="Runs without administrator rights" ` +
        `title="The agent runs without administrator rights; packages that go to Program Files will fail">${WARN_ICON}</span>`
      : "";
  const forget = agent.online
    ? ""
    : `<button type="button" class="link-btn" data-forget="${esc(agent.id)}" aria-label="Forget ${esc(nameOf(agent))}">Forget</button>`;
  return (
    `<tr class="${agent.online ? "" : "offline"}"><th scope="row" class="rowhead">` +
    `<div class="rowhead-in" title="${esc(agentDetails(agent))}">` +
    `<span class="dot${agent.online ? " on" : ""}"></span><span class="pc-name">${esc(nameOf(agent))}</span>${warn}` +
    `<span class="row-actions"><button type="button" class="link-btn" data-rename="${esc(agent.id)}" aria-label="Rename ${esc(nameOf(agent))}">Rename</button>${forget}</span>` +
    `</div></th>${pkgs.map((p) => cellHtml(agent, p)).join("")}</tr>`
  );
}

function renderMatrix() {
  const el = $("matrix");
  if (state.agents.length === 0) {
    el.innerHTML =
      `<div class="empty"><h2>No PCs yet</h2><p>Install the zeploy agent on the team's PCs. Each one shows up here as soon as it connects.</p>` +
      `<button type="button" class="btn primary" data-open="connect">Connect PC</button></div>`;
    return;
  }
  const pkgs = latestPackages();
  const head = pkgs
    .map(
      (p) =>
        `<th scope="col" class="colhead" style="--label:${labelFor(p.id)}">` +
        `<button type="button" class="colhead-btn" data-col="${esc(p.id)}" title="Select every PC for ${esc(p.name)}">` +
        `<span class="name">${esc(p.name)}</span><span class="ver code">${esc(p.version)}</span></button>` +
        `<button type="button" class="icon-btn colhead-remove" data-remove-pkg="${esc(p.id)}" data-version="${esc(p.version)}" ` +
        `aria-label="Remove ${esc(p.name)} ${esc(p.version)} from the repository" title="Remove from repository">${X_ICON}</button></th>`,
    )
    .join("");
  const visible = sortedAgents().filter(matchesFilter);
  const body = visible.length
    ? visible.map((a) => rowHtml(a, pkgs)).join("")
    : `<tr><td class="none-match" colspan="${pkgs.length + 1}">No PCs match.</td></tr>`;
  el.innerHTML =
    `<div class="matrix"><table class="grid" style="--pkgs:${pkgs.length}">` +
    `<thead><tr><th class="corner" scope="col"><span class="vh">PC</span></th>${head}</tr></thead>` +
    `<tbody>${body}</tbody></table></div>` +
    (pkgs.length
      ? ""
      : `<div class="empty"><h2>No packages yet</h2><p>Add a plugin folder with zeploy.json. Its column appears here, and you pick the PCs to install it on.</p>` +
        `<button type="button" class="btn primary" data-open="add">Add package</button></div>`);
}

// Selected cells that still exist, in table order, with what applying does.
function currentChanges() {
  const pkgs = latestPackages();
  const out = [];
  for (const agent of sortedAgents()) {
    for (const pkg of pkgs) {
      const key = cellKey(agent.id, pkg.id);
      if (!selection.has(key)) continue;
      const { status, receipt } = cellInfo(agent, pkg);
      const verb = { old: "Update", current: "Reinstall", failed: "Retry" }[status] ?? "Install";
      out.push({ key, agent, pkg, verb, installed: !!receipt });
    }
  }
  for (const key of [...selection.keys()]) if (!out.some((c) => c.key === key)) selection.delete(key);
  return out;
}

function renderChanges() {
  const changes = currentChanges();
  $("changes-count").textContent = changes.length ? String(changes.length) : "";
  $("changes-empty").hidden = changes.length > 0;
  $("changes-body").hidden = changes.length === 0;
  $("changes").innerHTML = changes
    .map(
      (c) =>
        `<li class="change" style="--label:${labelFor(c.pkg.id)}"><span class="key sm current" aria-hidden="true"></span>` +
        `<span class="what"><span class="verb">${c.verb}</span> ${esc(c.pkg.name)}</span><span class="pc">${esc(nameOf(c.agent))}</span>` +
        `<button type="button" class="icon-btn" data-drop="${esc(c.key)}" aria-label="Drop ${c.verb.toLowerCase()} ${esc(c.pkg.name)} on ${esc(nameOf(c.agent))}">${X_ICON}</button></li>`,
    )
    .join("");
  $("if-running").innerHTML = RUN_OPTIONS.map(
    (o) => `<button type="button" data-run="${o.id}" aria-pressed="${runMode === o.id}" title="${esc(o.title)}">${o.label}</button>`,
  ).join("");
  const help = RUN_OPTIONS.find((o) => o.id === runMode).help;
  $("if-running-help").textContent = help;
  $("if-running-help").hidden = !help;
  $("do-install").textContent = `Apply ${changes.length}`;
  $("do-uninstall").disabled = !changes.some((c) => c.installed);
}

function jobTitle(job, names) {
  const name = names.get(job.packageId) ?? job.packageId;
  return job.action === "install" ? `${name}${job.version ? ` ${job.version}` : ""}` : `Remove ${name}`;
}

function renderJobs() {
  const active = state.jobs.filter((j) => ACTIVE.has(j.status)).length;
  $("activity-count").textContent = active ? String(active) : "";
  const list = $("jobs");
  if (state.jobs.length === 0) {
    list.innerHTML = `<li class="empty-line">Nothing has run yet.</li>`;
    return;
  }
  const agents = new Map(state.agents.map((a) => [a.id, nameOf(a)]));
  const names = new Map(state.packages.map((p) => [p.id, p.name]));
  list.innerHTML = state.jobs
    .map((j) => {
      const cancelled = isCancelled(j);
      const statusLabel = cancelled ? "Cancelled" : STATUS[j.status];
      const keyClass = cancelled
        ? "cancelled"
        : j.status === "done" ? "done" : j.status === "failed" ? "failed" : j.status === "queued" ? "queued" : "busy";
      const open = j.id === openJobId;
      let extra = "";
      if (cancelled) {
        extra = `<div class="job-extra"><span class="reason muted">Cancelled</span><button type="button" class="btn xs" data-retry="${esc(j.id)}">Run again</button></div>`;
      } else if (j.status === "failed") {
        const reason = parseReason(j.error);
        extra =
          `<div class="job-extra"><span class="reason" title="${esc(j.error)}">${esc(reason.text)}</span>` +
          `<button type="button" class="btn xs" data-retry="${esc(j.id)}">Retry</button>` +
          (reason.app
            ? `<button type="button" class="btn xs primary" data-retry-kill="${esc(j.id)}">Close ${esc(reason.app)} &amp; retry</button>`
            : "") +
          `</div>`;
      } else if (j.status === "queued") {
        extra = `<div class="job-extra"><span class="reason muted">Waits for the PC to come online</span><button type="button" class="btn xs" data-cancel="${esc(j.id)}">Cancel</button></div>`;
      }
      const when = `${statusLabel}, created ${relTime(j.createdAt)}. Click to see the log.`;
      return (
        `<li class="job">` +
        `<button type="button" class="job-line" data-job="${esc(j.id)}" aria-expanded="${open}" title="${esc(when)}">` +
        `<span class="key sm ${keyClass}" aria-hidden="true"></span><span class="vh">${statusLabel}:</span>` +
        `<span class="job-title">${esc(jobTitle(j, names))}</span><span class="job-pc">${esc(agents.get(j.agentId) ?? "Unknown PC")}</span>` +
        `</button>${extra}${open ? `<pre class="log" id="open-log"></pre>` : ""}</li>`
      );
    })
    .join("");
  renderOpenLog();
}

function renderOpenLog() {
  const pre = $("open-log");
  if (!pre) return;
  pre.textContent = openJobLog.length ? openJobLog.join("\n") : "No log yet.";
  pre.scrollTop = pre.scrollHeight;
}

function renderSide() {
  $("tab-changes").setAttribute("aria-pressed", String(tab === "changes"));
  $("tab-activity").setAttribute("aria-pressed", String(tab === "activity"));
  $("panel-changes").hidden = tab !== "changes";
  $("panel-activity").hidden = tab !== "activity";
  renderChanges();
  renderJobs();
}

function renderRecent() {
  const recent = [...state.agents].sort((a, b) => b.firstSeen.localeCompare(a.firstSeen)).slice(0, 3);
  $("recent-pcs").innerHTML = recent
    .map(
      (a) =>
        `<li><span class="dot${a.online ? " on" : ""}"></span><span class="pc-name">${esc(nameOf(a))}</span>` +
        `<span class="when">${a.online ? `connected ${relTime(a.firstSeen)}` : "offline"}</span></li>`,
    )
    .join("");
}

// Re-rendering replaces the buttons; keep keyboard focus on the same one.
function focusSelector() {
  const el = document.activeElement;
  if (!el?.dataset) return null;
  for (const [attr, value] of Object.entries(el.dataset)) {
    if (attr === "pkg") continue;
    const kebab = attr.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    const pkg = el.dataset.pkg ? `[data-pkg="${CSS.escape(el.dataset.pkg)}"]` : "";
    return `[data-${kebab}="${CSS.escape(value)}"]${pkg}`;
  }
  return null;
}

function render() {
  if (!state) return;
  const focus = focusSelector();
  renderTop();
  renderFilters();
  renderMatrix();
  renderSide();
  if ($("connect-dialog").open) renderRecent();
  if (focus) document.querySelector(focus)?.focus();
}

// ---- actions ------------------------------------------------------------------------------

function toggleCell(agentId, packageId) {
  const key = cellKey(agentId, packageId);
  if (selection.has(key)) selection.delete(key);
  else selection.set(key, { agentId, packageId });
  tab = "changes";
  render();
}

function toggleColumn(packageId) {
  const agents = sortedAgents().filter(matchesFilter);
  const all = agents.every((a) => selection.has(cellKey(a.id, packageId)));
  for (const a of agents) {
    const key = cellKey(a.id, packageId);
    if (all) selection.delete(key);
    else selection.set(key, { agentId: a.id, packageId });
  }
  tab = "changes";
  render();
}

function selectForApps(packageId, apps) {
  for (const a of state.agents) {
    if (apps.some((app) => agentHasApp(a, app))) selection.set(cellKey(a.id, packageId), { agentId: a.id, packageId });
  }
  tab = "changes";
}

async function runAction(action) {
  const changes = currentChanges();
  const options = { ifRunning: runMode, replaceDevLinks: $("replace-dev-links").checked };
  const groups = new Map();
  let skipped = 0;
  for (const c of changes) {
    if (action === "uninstall" && !c.installed) {
      skipped++;
      continue;
    }
    if (!groups.has(c.pkg.id)) groups.set(c.pkg.id, { pkg: c.pkg, agentIds: [] });
    groups.get(c.pkg.id).agentIds.push(c.agent.id);
  }
  let sent = 0;
  try {
    for (const g of groups.values()) {
      await api("POST", "/api/jobs", {
        action,
        packageId: g.pkg.id,
        version: action === "install" ? g.pkg.version : undefined,
        agentIds: g.agentIds,
        options,
      });
      sent += g.agentIds.length;
    }
  } catch (err) {
    toast(err.message, true);
    return;
  }
  selection.clear();
  tab = "activity";
  render();
  const what = action === "install" ? "Install" : "Removal";
  toast(`${what} sent to ${pcs(sent)}.` + (skipped ? `\nSkipped ${skipped} not installed.` : ""));
}

async function retryJob(id, closeApp) {
  const job = state.jobs.find((j) => j.id === id);
  if (!job) return;
  await api("POST", "/api/jobs", {
    action: job.action,
    packageId: job.packageId,
    version: job.action === "install" ? job.version : undefined,
    agentIds: [job.agentId],
    options: { ...job.options, ifRunning: closeApp ? "kill" : job.options.ifRunning },
  });
  toast(closeApp ? "Retrying, and closing the app first." : "Retrying.");
}

async function toggleJob(id) {
  if (openJobId === id) {
    openJobId = null;
    render();
    return;
  }
  openJobId = id;
  openJobLog = [];
  render();
  try {
    const job = await api("GET", `/api/job?id=${encodeURIComponent(id)}`);
    if (openJobId === id) {
      openJobLog = job.log;
      renderOpenLog();
    }
  } catch (err) {
    toast(err.message, true);
  }
}

// ---- Add package --------------------------------------------------------------------------

let preview = null;
let inspectSeq = 0;
let inspectTimer = null;

function resetPreview() {
  preview = null;
  $("add-preview").hidden = true;
  $("add-error").hidden = true;
  $("add-select-row").hidden = true;
  $("add-submit").disabled = false;
}

function showAddError(message) {
  $("add-error").textContent = message;
  $("add-error").hidden = false;
}

function describe(p) {
  const types = [...new Set(p.components.map((c) => TYPE_LABELS[c.type] ?? c.type))];
  const apps = p.apps.map((a) => APP_LABELS[a] ?? a);
  return listText(types) + (apps.length ? ` for ${listText(apps)}` : "");
}

function renderPreview() {
  const box = $("add-preview");
  box.hidden = false;
  box.style.setProperty("--label", labelFor(preview.id));
  $("pv-name").textContent = preview.name;
  $("pv-version").textContent = preview.version;
  $("pv-desc").textContent = describe(preview);
  const status = $("pv-status");
  status.className = "pv-status";
  if (preview.status === "new") {
    status.classList.add("ok");
    status.innerHTML = `${CHECK_ICON}Ready`;
  } else if (preview.status === "same") {
    status.textContent = "Already added";
  } else {
    status.textContent = "";
    showAddError(`Version ${preview.version} is already added with other files. Raise "version" in zeploy.json.`);
    $("add-submit").disabled = true;
  }
  const targets = state.agents.filter((a) => preview.apps.some((app) => agentHasApp(a, app)));
  $("add-select-row").hidden = preview.status === "conflict" || targets.length === 0;
  $("add-select-label").textContent =
    `Then select the ${pcs(targets.length)} with ${listText(preview.apps.map((a) => APP_LABELS[a] ?? a))}`;
}

async function inspectNow() {
  const path = $("add-path").value.trim();
  const seq = ++inspectSeq;
  resetPreview();
  if (!path) return;
  $("add-preview").hidden = false;
  $("add-preview").style.removeProperty("--label");
  $("pv-name").textContent = "Checking…";
  $("pv-version").textContent = "";
  $("pv-desc").textContent = "";
  $("pv-status").textContent = "";
  try {
    const p = await api("POST", "/api/packages/inspect", { path });
    if (seq !== inspectSeq) return;
    preview = p;
    renderPreview();
  } catch (err) {
    if (seq !== inspectSeq) return;
    $("add-preview").hidden = true;
    showAddError(err.message);
  }
}

function openAdd() {
  resetPreview();
  $("add-path").value = "";
  $("pick-folder").hidden = !desktop;
  $("add-select").checked = remember.get("autoSelect") !== "0";
  $("add-dialog").showModal();
  $("add-path").focus();
}

function afterAdd(record, autoSelect) {
  toast(`Added ${record.name} ${record.version}`);
  if (!autoSelect || !record.apps?.length) return;
  if (state.packages.some((p) => p.id === record.id && p.version === record.version)) {
    selectForApps(record.id, record.apps);
    render();
  } else {
    pendingSelect = { id: record.id, version: record.version, apps: record.apps };
  }
}

async function uploadZip(file) {
  if (!/\.zip$/i.test(file.name)) {
    toast("Only .zip files can be added by drag and drop.", true);
    return;
  }
  try {
    const record = await api("POST", "/api/packages/upload", file);
    afterAdd(record, remember.get("autoSelect") !== "0");
  } catch (err) {
    toast(err.message, true);
  }
}

// ---- Connect PC ---------------------------------------------------------------------------

function serverAddress() {
  const host = $("setup-address").value || state.addresses[0] || "this-computer-ip";
  return `${host}:${state.port}`;
}

function renderSetupCommand() {
  // ".\" so PowerShell runs the exe from the current folder (cmd accepts it too).
  $("setup-command").textContent = `.\\zeploy-agent.exe setup --server ${serverAddress()} --token ${state.enrollToken}`;
  $("server-address").textContent = serverAddress();
}

function openConnect() {
  const select = $("setup-address");
  const current = select.value;
  select.innerHTML = state.addresses.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
  if (state.addresses.includes(current)) select.value = current;
  $("setup-address-row").hidden = state.addresses.length < 2;

  $("installer-folder").value ||= remember.get("installerFolder");
  $("pick-installer-folder").hidden = !desktop;
  $("save-installer").disabled = !state.installerReady;
  $("installer-result").hidden = true;
  $("installer-error").textContent = state.installerReady
    ? ""
    : "This admin app has no zeploy-agent.exe to hand out yet. Run npm run build:agent, then npm run admin.";
  $("installer-error").hidden = state.installerReady;
  $("port-hint").textContent = String(state.port);
  renderSetupCommand();
  renderRecent();
  $("connect-dialog").showModal();
}

async function saveInstaller() {
  const folder = $("installer-folder").value.trim();
  const error = $("installer-error");
  const result = $("installer-result");
  error.hidden = true;
  result.hidden = true;
  if (!folder) {
    error.textContent = "Enter the folder to save the installer in.";
    error.hidden = false;
    return;
  }
  $("save-installer").disabled = true;
  try {
    await api("POST", "/api/installer", { folder, server: serverAddress() });
    remember.set("installerFolder", folder);
    result.textContent = "Saved Install zeploy agent.cmd and zeploy-agent.exe";
    result.hidden = false;
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    $("save-installer").disabled = !state.installerReady;
  }
}

// ---- Rename PC ----------------------------------------------------------------------------

function openRename(agentId) {
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) return;
  renamingId = agentId;
  $("rename-hint").textContent = `Only zeploy shows this name. The Windows name stays ${agent.hostname}.`;
  $("rename-input").value = agent.label ?? "";
  $("rename-input").placeholder = agent.hostname;
  $("rename-error").hidden = true;
  $("rename-dialog").showModal();
  $("rename-input").select();
}

async function saveRename(label) {
  try {
    await api("POST", "/api/agents/rename", { id: renamingId, label });
    $("rename-dialog").close();
  } catch (err) {
    $("rename-error").textContent = err.message;
    $("rename-error").hidden = false;
  }
}

// ---- events -------------------------------------------------------------------------------

document.addEventListener("click", async (event) => {
  const el = event.target.closest("button");
  if (!el) return;
  const d = el.dataset;
  try {
    if (d.agent && d.pkg) toggleCell(d.agent, d.pkg);
    else if (d.col) toggleColumn(d.col);
    else if (d.filter) {
      filter = d.filter;
      render();
    } else if (d.drop) {
      selection.delete(d.drop);
      render();
    } else if (d.run) {
      runMode = d.run;
      render();
    } else if (d.job) await toggleJob(d.job);
    else if (d.retry) await retryJob(d.retry, false);
    else if (d.retryKill) await retryJob(d.retryKill, true);
    else if (d.cancel) await api("POST", `/api/jobs/cancel?id=${encodeURIComponent(d.cancel)}`);
    else if (d.open === "connect") openConnect();
    else if (d.open === "add") openAdd();
    else if (d.rename) openRename(d.rename);
    else if (d.close !== undefined) el.closest("dialog")?.close();
    else if (d.forget) {
      const agent = state.agents.find((a) => a.id === d.forget);
      if (confirm(`Forget ${agent ? nameOf(agent) : "this PC"}? It comes back when its agent connects again.`)) {
        await api("DELETE", `/api/agents?id=${encodeURIComponent(d.forget)}`);
      }
    } else if (d.removePkg) {
      if (confirm(`Remove ${d.removePkg} ${d.version} from the repository? Plugins already installed on PCs stay installed.`)) {
        await api("DELETE", `/api/packages?id=${encodeURIComponent(d.removePkg)}&version=${encodeURIComponent(d.version)}`);
      }
    }
  } catch (err) {
    toast(err.message, true);
  }
});

$("tab-changes").addEventListener("click", () => {
  tab = "changes";
  render();
});
$("tab-activity").addEventListener("click", () => {
  tab = "activity";
  render();
});
$("connect-pc").addEventListener("click", () => state && openConnect());
$("add-package").addEventListener("click", openAdd);
$("do-install").addEventListener("click", () => runAction("install"));
$("do-uninstall").addEventListener("click", () => runAction("uninstall"));
$("clear-selection").addEventListener("click", () => {
  selection.clear();
  render();
});

$("add-path").addEventListener("input", () => {
  clearTimeout(inspectTimer);
  inspectTimer = setTimeout(inspectNow, 350);
});
$("pick-folder").addEventListener("click", async () => {
  const path = await desktop?.pickFolder("Choose a plugin folder (with zeploy.json)");
  if (!path) return;
  $("add-path").value = path;
  void inspectNow();
});
$("add-select").addEventListener("change", () => remember.set("autoSelect", $("add-select").checked ? "1" : "0"));
$("add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const path = $("add-path").value.trim();
  if (!path) {
    showAddError("Enter the path of a plugin folder or .zip file.");
    return;
  }
  $("add-submit").disabled = true;
  try {
    const record = await api("POST", "/api/packages/import", { path });
    $("add-dialog").close();
    afterAdd(record, $("add-select").checked);
  } catch (err) {
    showAddError(err.message);
  } finally {
    $("add-submit").disabled = preview?.status === "conflict";
  }
});

$("pick-installer-folder").addEventListener("click", async () => {
  const path = await desktop?.pickFolder("Choose where to save the installer");
  if (path) $("installer-folder").value = path;
});
$("save-installer").addEventListener("click", saveInstaller);
$("installer-folder").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  void saveInstaller();
});
$("setup-address").addEventListener("change", renderSetupCommand);
$("copy-setup").addEventListener("click", () => copy($("setup-command").textContent, "Command copied."));
$("copy-token").addEventListener("click", () => copy(state.enrollToken, "Team token copied."));

$("rename-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void saveRename($("rename-input").value.trim());
});
$("rename-reset").addEventListener("click", () => void saveRename(""));

// Drag a .zip anywhere onto the window to add it.
let dragDepth = 0;
const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
document.addEventListener("dragenter", (event) => {
  if (!hasFiles(event)) return;
  dragDepth++;
  document.body.classList.add("dragging");
});
document.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove("dragging");
  }
});
document.addEventListener("dragover", (event) => hasFiles(event) && event.preventDefault());
document.addEventListener("drop", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const file = event.dataTransfer.files[0];
  if (file) void uploadZip(file);
});

// ---- live updates -------------------------------------------------------------------------

function connectEvents() {
  const events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  events.addEventListener("open", () => ($("banner").hidden = true));
  events.addEventListener("error", () => {
    $("banner").textContent = "Lost the connection to the admin server. Reconnecting…";
    $("banner").hidden = false;
  });
  events.addEventListener("state", (event) => {
    state = JSON.parse(event.data);
    if (pendingSelect && state.packages.some((p) => p.id === pendingSelect.id && p.version === pendingSelect.version)) {
      selectForApps(pendingSelect.id, pendingSelect.apps);
      pendingSelect = null;
    }
    render();
  });
  events.addEventListener("log", (event) => {
    const { jobId, line } = JSON.parse(event.data);
    if (jobId === openJobId) {
      openJobLog.push(line);
      renderOpenLog();
    }
  });
}

connectEvents();
// Relative times ("5 min ago") age without server events.
setInterval(render, 30_000);
