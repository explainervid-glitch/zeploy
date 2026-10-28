"use strict";

// zeploy admin UI. Plain browser JavaScript, no build step: the server serves
// this file as is, both to the Electron window and to a browser on this PC.

const token = document.querySelector('meta[name="admin-token"]').content;
// Present only inside the Electron app (see packages/admin/preload.cjs).
const desktop = window.zeployDesktop ?? null;
// In the desktop app the top bar is also the window's title bar (style.css).
if (desktop) document.documentElement.classList.add("desktop");

// The braille spinner in every busy status mark ([⠋]): one frame variable
// for all of them (style.css). Still when motion is reduced.
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  let frame = 0;
  setInterval(() => {
    if (!document.querySelector(".key.busy")) return;
    frame = (frame + 1) % SPIN.length;
    document.documentElement.style.setProperty("--spin", `"${SPIN[frame]}"`);
  }, 100);
}

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
    init.headers["content-type"] = "application/octet-stream";
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
  // Grouped by app (see appGroup), then by name.
  return [...byId.values()].sort((a, b) => appGroup(a).order - appGroup(b).order || appGroup(a).label.localeCompare(appGroup(b).label) || a.name.localeCompare(b.name));
}

const APP_ORDER = ["aftereffects", "premiere", "animate", "blender"];

// The column group a package sits in: its app, or its apps together for a
// panel that loads in several ("After Effects + Premiere Pro").
function appGroup(pkg) {
  const apps = [...new Set(pkg.apps ?? [])].sort((a, b) => APP_ORDER.indexOf(a) - APP_ORDER.indexOf(b));
  if (!apps.length) return { key: "", label: "Other", title: "Apps not known", order: 99 };
  const first = APP_ORDER.indexOf(apps[0]);
  return {
    key: apps.join("+"),
    label: apps.map((a) => APP_SHORT[a] ?? APP_LABELS[a] ?? a).join(" + "),
    title: apps.map((a) => APP_LABELS[a] ?? a).join(" + "),
    // Single-app groups first in app order, then combinations after their first app.
    order: (first < 0 ? 50 : first) * 2 + (apps.length > 1 ? 1 : 0),
  };
}

function relTime(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// Asks before something that cannot be undone. Cancel has the focus, so
// Enter or Esc never removes anything by accident.
function askConfirm({ title, body, action }) {
  const dialog = $("confirm-dialog");
  $("confirm-title").textContent = title;
  $("confirm-body").textContent = body;
  $("confirm-ok").textContent = action;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
  });
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

// How a PC is, beyond online and offline (agent 0.9.0 and its waker):
//   error: the agent hit problems, a job on it failed, or it stopped with an error;
//   idle:  the PC is on (its waker answers) but the agent does not run.
// `reasons` say what is wrong; `wake` whether Wake up can help.
function pcStatus(agent) {
  if (agent.online) {
    const reasons = (agent.state?.problems ?? []).map((p) => `${p.message} (${relTime(p.at)})`);
    const failed = latestPackages().filter((p) => cellInfo(agent, p).status === "failed");
    if (failed.length) reasons.push(`${listText(failed.map((p) => p.name))}: last job failed`);
    const update = state.jobs.find((j) => j.agentId === agent.id && isAgentJob(j) && !isCancelled(j));
    if (update?.status === "failed" && compareSemver(agent.agentVersion, update.version ?? "0.0.0") < 0) {
      reasons.push(`agent update to ${update.version} failed`);
    }
    return reasons.length ? { kind: "error", reasons, wake: false } : { kind: "online", reasons, wake: false };
  }
  const w = agent.waker?.status;
  if (!w) return { kind: "offline", reasons: [], wake: false };
  if (w.agentRunning) return { kind: "error", reasons: ["the agent runs but cannot reach this admin computer"], wake: false };
  if (w.crash) return { kind: "error", reasons: [`the agent stopped ${relTime(w.crash.at)}: ${w.crash.error}`], wake: true };
  return {
    kind: "idle",
    reasons: [w.signedIn ? "the PC is on, but its agent is not running" : `the PC is on; nobody is signed in as ${agent.user}`],
    wake: true,
  };
}

const STATUS_WORDS = { online: "Online", offline: "Offline", idle: "Idle", error: "Error" };

function agentDetails(agent) {
  const s = pcStatus(agent);
  const waker = agent.state?.waker;
  return [
    agent.role ? `Role: ${agent.role}` : "No role",
    agent.label ? `${agent.hostname}, ${agent.address}` : agent.address,
    agent.online ? `Online, user ${agent.user}` : `${STATUS_WORDS[s.kind]}, last seen ${relTime(agent.lastSeen)}`,
    ...s.reasons.map((r) => `! ${r}`),
    agentApps(agent),
    `Agent ${agent.agentVersion}`,
    ...(waker && !waker.running ? [`No waker: ${waker.error ?? "not running"}`] : []),
  ].join("\n");
}

const isAgentJob = (job) => job.action === "updateAgent";

// Where a PC's agent stands against the zeploy-agent.exe the admin app has:
// null when it is up to date (or the admin app has no exe).
function agentUpdate(agent) {
  const target = state.agentBuild?.version;
  if (!target || compareSemver(agent.agentVersion, target) >= 0) return null;
  return {
    target,
    // Agents before 0.3.0 cannot update themselves.
    canUpdate: (agent.features ?? []).includes("self-update"),
    job: state.jobs.find((j) => j.agentId === agent.id && isAgentJob(j) && ACTIVE.has(j.status)) ?? null,
  };
}

const agentsToUpdate = () => state.agents.filter((a) => agentUpdate(a)?.canUpdate && !agentUpdate(a).job);

// Grouped by role (named roles A to Z, PCs without one last), then online
// first, then by name.
function sortedAgents() {
  const rank = (a) => (a.role ? 0 : 1);
  return [...state.agents].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.role ?? "").localeCompare(b.role ?? "") ||
      b.online - a.online ||
      nameOf(a).localeCompare(nameOf(b)),
  );
}

const roles = () => [...new Set(state.agents.map((a) => a.role).filter(Boolean))].sort((a, b) => a.localeCompare(b));

// Table rows with a header row above each role, once any PC has a role.
function rowsByRole(agents, pkgs) {
  if (!state.agents.some((a) => a.role)) return agents.map((a) => rowHtml(a, pkgs)).join("");
  let html = "";
  let current = null;
  for (const agent of agents) {
    const role = agent.role ?? "";
    if (role !== current) {
      current = role;
      const members = agents.filter((a) => (a.role ?? "") === role);
      const online = members.filter((a) => a.online).length;
      html +=
        `<tr class="role-row"><th scope="rowgroup" colspan="${pkgs.length + 1}"><span class="role-in">` +
        `<span class="role-name">${esc(role || "No role")}</span>` +
        `<span class="role-count">${pcs(members.length)}, ${online} online</span></span></th></tr>`;
    }
    html += rowHtml(agent, pkgs);
  }
  return html;
}

// A queued job the admin cancelled: the server records it as failed with this error.
const isCancelled = (job) => job.status === "failed" && job.error === "cancelled";

// What a PC has of a package, and what zeploy is doing about it.
function cellInfo(agent, pkg) {
  const receipt = agent.state?.receipts.find((r) => r.id === pkg.id) ?? null;
  const jobs = state.jobs.filter((j) => j.agentId === agent.id && j.packageId === pkg.id && !isAgentJob(j) && !isCancelled(j));
  const active = jobs.find((j) => ACTIVE.has(j.status));
  const last = jobs.find((j) => !ACTIVE.has(j.status));
  const found = receipt ? null : foundOn(agent, pkg);
  let status;
  if (active) status = active.status === "queued" ? "queued" : "busy";
  else if (last?.status === "failed") status = "failed";
  else if (receipt?.failed?.length && receipt.version === pkg.version) status = "partial";
  else if (receipt) status = compareSemver(receipt.version, pkg.version) >= 0 ? "current" : "old";
  else if (found) status = "found";
  else status = "none";
  return { status, receipt, active, found };
}

// Where the newest version of a package that remembers it was added from.
function sourceOf(pkg) {
  return state.packages
    .filter((p) => p.id === pkg.id && p.source)
    .sort((a, b) => compareSemver(b.version, a.version))[0]?.source ?? null;
}

// Reads a package's source again. A newer version that needs nothing typed
// in is added straight away; anything else opens the Add dialog on it.
async function refreshPackage(id) {
  const pkg = latestPackages().find((p) => p.id === id);
  const path = pkg && sourceOf(pkg);
  if (!path) return;
  let preview;
  try {
    preview = await api("POST", "/api/packages/inspect", { path, overrides: { id } });
  } catch (err) {
    toast(`${pkg.name}: ${err.message}`, true);
    return;
  }
  if (preview.id === id && preview.status === "same" && preview.version === pkg.version) {
    toast(`${pkg.name} ${pkg.version} is the newest at\n${path}`);
  } else if (preview.id === id && preview.status === "new" && compareSemver(preview.version, pkg.version) > 0) {
    const record = await api("POST", "/api/packages/import", { path, overrides: { id } });
    toast(`Updated ${pkg.name} to ${record.version}. Select the PCs that show Update.`);
  } else {
    openAdd(path, { id });
  }
}

// Plugin identities of a package, from every version of it in the repository.
function packageKeys(pkg) {
  const keys = new Set(state.packages.filter((p) => p.id === pkg.id).flatMap((p) => p.keys ?? []));
  // A .zxp lands in a CEP extensions folder, where agents report it as cep:.
  for (const k of [...keys]) if (k.startsWith("zxp:")) keys.add(`cep:${k.slice(4)}`);
  return keys;
}

// The plugin on that PC without a zeploy install record: copied by hand or
// installed some other way. Of several copies, the oldest version counts.
function foundOn(agent, pkg) {
  const keys = packageKeys(pkg);
  const hits = (agent.state?.found ?? []).filter((f) => keys.has(f.key));
  if (!hits.length) return null;
  return hits.sort((a, b) => compareSemver(a.version ?? "0.0.0", b.version ?? "0.0.0"))[0];
}

function hasStatus(agent, status) {
  return latestPackages().some((p) => cellInfo(agent, p).status === status);
}

function matchesFilter(agent) {
  if (filter === "updates") return hasStatus(agent, "old");
  if (filter === "failed") return hasStatus(agent, "failed") || hasStatus(agent, "partial");
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
  $("status-server").textContent = state.addresses.length
    ? `listening ${state.addresses[0]}:${state.port}`
    : `listening :${state.port}, no network`;
}

function renderFilters() {
  const el = $("filters");
  el.hidden = state.agents.length === 0;
  const counts = {
    updates: state.agents.filter((a) => hasStatus(a, "old")).length,
    failed: state.agents.filter((a) => hasStatus(a, "failed") || hasStatus(a, "partial")).length,
    offline: state.agents.filter((a) => !a.online).length,
  };
  el.innerHTML = FILTERS.map((f) => {
    const n = counts[f.id] ?? 0;
    const count = n ? `<span class="n${f.id === "failed" ? " err" : ""}">${n}</span>` : "";
    return `<button type="button" class="filter" data-filter="${f.id}" aria-pressed="${filter === f.id}">${f.label}${count}</button>`;
  }).join("");

  const outdated = agentsToUpdate();
  const button = $("update-agents");
  button.hidden = outdated.length === 0;
  button.textContent = `Update ${outdated.length === 1 ? "1 agent" : `${outdated.length} agents`} to ${state.agentBuild?.version}`;
  button.title = `${listText(outdated.map(nameOf))}. A PC that is offline updates when it next connects.`;
}

// The agent's version when the PC should get a newer agent, and how.
function agentTagHtml(agent) {
  const u = agentUpdate(agent);
  if (!u) return "";
  if (u.job) {
    return `<span class="agent-tag busy" title="Updating the agent to ${esc(u.target)}">Updating agent</span>`;
  }
  const title = u.canUpdate
    ? `Agent ${agent.agentVersion}; ${u.target} is available`
    : `Agent ${agent.agentVersion} cannot update itself. Save the installer under Connect PC and run it on this PC once; ` +
      `from then on its agent updates from here.`;
  return `<span class="agent-tag" title="${esc(title)}">Agent ${esc(agent.agentVersion)}</span>`;
}

function cellHtml(agent, pkg) {
  const { status, receipt, active, found } = cellInfo(agent, pkg);
  const removing = active?.action === "uninstall";
  const foundCap = found?.version ? `Found ${found.version}` : "Found";
  const caption = { old: "Update", busy: removing ? "Removing" : "Installing", queued: "Queued", failed: "Failed", found: foundCap, partial: "Partial" }[status] ?? "";
  const words = {
    current: `version ${receipt?.version}, up to date`,
    old: `version ${receipt?.version}, update to ${pkg.version}`,
    found: `already there without zeploy${found?.version ? `, version ${found.version}` : ""} (${found?.where}); installing replaces it`,
    none: "not installed",
    busy: removing ? "removing" : "installing",
    queued: "queued",
    failed: `last job failed${receipt ? `, version ${receipt.version} installed` : ""}`,
    partial: `version ${receipt?.version} partly installed: failed in ${(receipt?.failed ?? []).join(", ")}`,
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

function statusDot(agent) {
  const kind = pcStatus(agent).kind;
  return `<span class="dot ${{ online: "on", idle: "idle", error: "err", offline: "" }[kind]}" aria-label="${STATUS_WORDS[kind]}" role="img"></span>`;
}

// Idle and error next to the PC's name, with what can be done about them.
// Show log needs the waker (agent 0.9.0).
function statusHtml(agent) {
  const s = pcStatus(agent);
  if (s.kind !== "idle" && s.kind !== "error") return "";
  const name = esc(nameOf(agent));
  const canLog = (agent.features ?? []).includes("waker");
  return (
    `<span class="state-tag ${s.kind === "idle" ? "idle" : "err"}" title="${esc(s.reasons.join("\n"))}">${STATUS_WORDS[s.kind]}</span>` +
    (s.wake ? `<button type="button" class="state-btn" data-wake="${esc(agent.id)}" aria-label="Wake up the agent on ${name}">Wake up</button>` : "") +
    (s.kind === "error" && canLog ? `<button type="button" class="state-btn" data-show-log="${esc(agent.id)}" aria-label="Show the agent log of ${name}">Show log</button>` : "")
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
  const u = agentUpdate(agent);
  const update =
    u?.canUpdate && !u.job
      ? `<button type="button" class="link-btn" data-update-agent="${esc(agent.id)}" aria-label="Update the agent on ${esc(nameOf(agent))} to ${esc(u.target)}">Update agent</button>`
      : "";
  return (
    `<tr class="${agent.online ? "" : "offline"}"><th scope="row" class="rowhead">` +
    `<div class="rowhead-in" title="${esc(agentDetails(agent))}">` +
    `${statusDot(agent)}<span class="pc-name">${esc(nameOf(agent))}</span>${statusHtml(agent)}${warn}${agentTagHtml(agent)}` +
    `<span class="row-actions">${update}<button type="button" class="link-btn" data-rename="${esc(agent.id)}" aria-label="Edit the name and role of ${esc(nameOf(agent))}">Edit</button>${forget}</span>` +
    `</div></th>${pkgs.map((p) => cellHtml(agent, p)).join("")}</tr>`
  );
}

// One header cell per app group, spanning its packages' columns.
function groupHead(pkgs) {
  const groups = [];
  for (const p of pkgs) {
    const g = appGroup(p);
    if (groups.at(-1)?.key === g.key) groups.at(-1).n++;
    else groups.push({ ...g, n: 1 });
  }
  return groups.map((g) => `<th scope="colgroup" colspan="${g.n}" class="group" title="${esc(g.title)}">${esc(g.label)}</th>`).join("");
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
        (sourceOf(p)
          ? `<button type="button" class="icon-btn colhead-update" data-refresh-pkg="${esc(p.id)}" ` +
            `aria-label="Check ${esc(sourceOf(p))} for a newer version of ${esc(p.name)}" title="Check for a newer version at ${esc(sourceOf(p))}">↻</button>`
          : "") +
        `<button type="button" class="icon-btn colhead-remove" data-remove-pkg="${esc(p.id)}" data-version="${esc(p.version)}" ` +
        `aria-label="Remove ${esc(p.name)} ${esc(p.version)} from the repository" title="Remove from repository">${X_ICON}</button></th>`,
    )
    .join("");
  const visible = sortedAgents().filter(matchesFilter);
  const body = visible.length
    ? rowsByRole(visible, pkgs)
    : `<tr><td class="none-match" colspan="${pkgs.length + 1}">No PCs match.</td></tr>`;
  // The table scrolls inside its box (so the PC column and package headers
  // stay put); a re-render keeps where it was scrolled to.
  const old = el.querySelector(".matrix");
  const scroll = old ? [old.scrollLeft, old.scrollTop] : null;
  el.innerHTML =
    `<div class="matrix"><table class="grid" style="--pkgs:${pkgs.length}">` +
    `<thead><tr class="groups"><th class="corner" scope="col" rowspan="2"><span class="vh">PC</span></th>${groupHead(pkgs)}</tr>` +
    `<tr>${head}</tr></thead>` +
    `<tbody>${body}</tbody></table></div>` +
    (pkgs.length
      ? ""
      : `<div class="empty"><h2>No packages yet</h2><p>Add a plugin folder with zeploy.json. Its column appears here, and you pick the PCs to install it on.</p>` +
        `<button type="button" class="btn primary" data-open="add">Add package</button></div>`);
  const frame = el.querySelector(".matrix");
  // The package names stick just below the app groups row.
  frame.style.setProperty("--groups-h", `${el.querySelector("tr.groups")?.offsetHeight ?? 0}px`);
  if (scroll) [frame.scrollLeft, frame.scrollTop] = scroll;
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
      const verb = { old: "Update", current: "Reinstall", failed: "Retry", found: "Replace", partial: "Retry" }[status] ?? "Install";
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
  const verbs = new Set(changes.map((c) => c.verb));
  const only = verbs.size === 1 ? [...verbs][0] : "Apply";
  $("do-install").textContent = `${only} ${changes.length}`;
  // Remove only acts on cells where the plugin is installed.
  const installed = changes.filter((c) => c.installed).length;
  const remove = $("do-uninstall");
  remove.hidden = installed === 0;
  remove.textContent = `Remove ${installed} from PCs`;
  remove.title = `Uninstall from the selected PCs that have it${installed < changes.length ? `; ${changes.length - installed} not installed are skipped` : ""}`;
}

function jobTitle(job, names) {
  if (isAgentJob(job)) return `Agent ${job.version}`;
  const name = names.get(job.packageId) ?? job.packageId;
  return job.action === "install" ? `${name}${job.version ? ` ${job.version}` : ""}` : `Remove ${name}`;
}

function renderJobs() {
  const active = state.jobs.filter((j) => ACTIVE.has(j.status)).length;
  $("activity-count").textContent = active ? String(active) : "";
  const list = $("jobs");
  // Today's jobs, and any still waiting or running from before.
  const today = localDayKey(0);
  const jobs = state.jobs.filter((j) => ACTIVE.has(j.status) || dayKeyOf(new Date(j.finishedAt ?? j.createdAt)) === today);
  if (jobs.length === 0) {
    list.innerHTML = `<li class="empty-line">${state.jobs.length ? "Nothing has run today." : "Nothing has run yet."}</li>`;
    return;
  }
  const agents = new Map(state.agents.map((a) => [a.id, nameOf(a)]));
  const names = new Map(state.packages.map((p) => [p.id, p.name]));
  list.innerHTML = jobs
    .map((j) => {
      const cancelled = isCancelled(j);
      const partly = j.status === "done" && j.partial?.length;
      const statusLabel = cancelled ? "Cancelled" : partly ? "Partly done" : STATUS[j.status];
      const keyClass = cancelled
        ? "cancelled"
        : partly ? "partial" : j.status === "done" ? "done" : j.status === "failed" ? "failed" : j.status === "queued" ? "queued" : "busy";
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
      } else if (partly) {
        const parts = j.partial.map((p) => p.split(":")[0]);
        extra =
          `<div class="job-extra"><span class="reason warn" title="${esc(j.partial.join("\n"))}">Failed in ${esc(listText(parts))}</span>` +
          `<button type="button" class="btn xs" data-retry="${esc(j.id)}">Retry</button></div>`;
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
  $("strip-changes").textContent = $("changes-count").textContent || "0";
  $("strip-activity").textContent = $("activity-count").textContent || "0";
}

// ---- side panel size ------------------------------------------------------------------------
// Dragging the bar between table and panel resizes the panel; it can also
// collapse to a strip. Both are remembered per browser.

const SIDE_DEFAULT = 340;
const SIDE_MIN = 260;
const SIDE_STEP = 24;
const sideMax = () => Math.max(SIDE_MIN, Math.round(window.innerWidth * 0.6));
let sideWidth = Number(remember.get("sideWidth")) || SIDE_DEFAULT;
let sideCollapsed = remember.get("sideCollapsed") === "1";

function applySide() {
  sideWidth = Math.round(Math.min(Math.max(sideWidth, SIDE_MIN), sideMax()));
  document.querySelector(".layout").style.setProperty("--side-w", `${sideWidth}px`);
  document.body.classList.toggle("side-collapsed", sideCollapsed);
  const bar = $("side-resizer");
  bar.hidden = sideCollapsed;
  bar.setAttribute("aria-valuenow", String(sideWidth));
  bar.setAttribute("aria-valuemin", String(SIDE_MIN));
  bar.setAttribute("aria-valuemax", String(sideMax()));
}

function setSideWidth(width) {
  sideWidth = width;
  applySide();
  remember.set("sideWidth", String(sideWidth));
}

function setSideCollapsed(collapsed) {
  sideCollapsed = collapsed;
  remember.set("sideCollapsed", collapsed ? "1" : "0");
  applySide();
  $(collapsed ? "side-expand" : "side-collapse").focus();
}

$("side-collapse").addEventListener("click", () => setSideCollapsed(true));
$("side-expand").addEventListener("click", () => setSideCollapsed(false));
$("side-resizer").addEventListener("dblclick", () => setSideWidth(SIDE_DEFAULT));
$("side-resizer").addEventListener("pointerdown", (event) => {
  const bar = event.currentTarget;
  bar.setPointerCapture(event.pointerId);
  document.body.classList.add("resizing");
  const right = document.querySelector(".layout").getBoundingClientRect().right;
  const move = (e) => {
    sideWidth = right - e.clientX;
    applySide();
  };
  const end = () => {
    bar.removeEventListener("pointermove", move);
    document.body.classList.remove("resizing");
    setSideWidth(sideWidth);
  };
  bar.addEventListener("pointermove", move);
  bar.addEventListener("pointerup", end, { once: true });
  bar.addEventListener("pointercancel", end, { once: true });
});
// The bar moves with the arrow keys: left widens the panel, right narrows it.
$("side-resizer").addEventListener("keydown", (event) => {
  const delta = { ArrowLeft: SIDE_STEP, ArrowRight: -SIDE_STEP }[event.key];
  if (delta) setSideWidth(sideWidth + delta);
  else if (event.key === "Home") setSideWidth(sideMax());
  else if (event.key === "End") setSideWidth(SIDE_MIN);
  else if (event.key === "Enter") setSideCollapsed(true);
  else return;
  event.preventDefault();
});
window.addEventListener("resize", applySide);
applySide();

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
  if ($("settings-dialog").open) renderSettings();
  if (view === "dashboard") renderDashboard();
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
  if (action === "uninstall" && groups.size) {
    const names = new Map(state.agents.map((a) => [a.id, nameOf(a)]));
    const pcCount = new Set([...groups.values()].flatMap((g) => g.agentIds)).size;
    const lines = [...groups.values()].map((g) => `${g.pkg.name} from ${listText(g.agentIds.map((id) => names.get(id)))}`);
    const ok = await askConfirm({
      title: `Remove from ${pcs(pcCount)}?`,
      body: `${lines.join("\n")}\n\nzeploy deletes what it installed there. You can install it again later.`,
      action: "Remove",
    });
    if (!ok) return;
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

// Queues an agent update for each PC; offline PCs update when they connect.
async function updateAgents(agentIds) {
  await api("POST", "/api/agents/update", { agentIds });
  tab = "activity";
  render();
  toast(`Agent update sent to ${pcs(agentIds.length)}.`);
}

async function retryJob(id, closeApp) {
  const job = state.jobs.find((j) => j.id === id);
  if (!job) return;
  if (isAgentJob(job)) return updateAgents([job.agentId]);
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
// For a plugin without zeploy.json: the detected details the admin changed,
// sent along with every inspect and the import. Cleared for a new path.
let overrides = {};

const DETECTED_FIELDS = { name: "dt-name", version: "dt-version", id: "dt-id", extensionName: "dt-ext" };
const FROM_LABELS = {
  "CSXS/manifest.xml": "CSXS/manifest.xml",
  "manifest.json": "its manifest.json",
  "blender_manifest.toml": "blender_manifest.toml",
  bl_info: "bl_info",
  "the script": "the script",
  "the file name": "the file name",
};

function resetPreview() {
  preview = null;
  $("add-preview").hidden = true;
  $("add-error").hidden = true;
  $("add-select-row").hidden = true;
  $("add-submit").disabled = false;
}

// The detected details as editable fields. Fields the admin is typing in
// keep their text; the rest follow what the server worked out.
function renderDetected() {
  const d = preview?.detected;
  $("add-detected").hidden = !d;
  if (!d) return;
  $("dt-from").textContent = `No zeploy.json: read from ${FROM_LABELS[d.from] ?? d.from}. Change anything that is wrong.`;
  const values = { name: preview.name, version: preview.version, id: preview.id, extensionName: d.extensionName ?? "" };
  for (const [key, id] of Object.entries(DETECTED_FIELDS)) {
    const input = $(id);
    if (document.activeElement !== input && !(key in overrides)) input.value = values[key];
  }
  $("dt-ext-row").hidden = d.extensionName === undefined;
  $("dt-version").classList.toggle("needs", d.missing.includes("version"));
  const u = d.updates;
  $("dt-updates").hidden = !u;
  if (u) $("dt-updates").textContent = `Another version of ${u.name}, which has ${u.version} in zeploy.`;
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
  } else if (preview.status === "incomplete") {
    status.classList.add("warn");
    status.textContent = "Needs a version";
    $("add-submit").disabled = true;
  } else {
    status.textContent = "";
    const where = preview.detected ? "Raise the version." : `Raise "version" in zeploy.json.`;
    showAddError(`Version ${preview.version} is already added with other files. ${where}`);
    $("add-submit").disabled = true;
  }
  renderDetected();
  const blocked = preview.status === "conflict" || preview.status === "incomplete";
  const targets = state.agents.filter((a) => preview.apps.some((app) => agentHasApp(a, app)));
  $("add-select-row").hidden = blocked || targets.length === 0;
  $("add-select-label").textContent =
    `Then select the ${pcs(targets.length)} with ${listText(preview.apps.map((a) => APP_LABELS[a] ?? a))}`;
}

// `editing`: re-checking after a detected field changed, so the preview and
// the fields stay where they are until the answer comes.
async function inspectNow(editing = false) {
  const path = $("add-path").value.trim();
  const seq = ++inspectSeq;
  if (!editing) {
    resetPreview();
    $("add-detected").hidden = true;
  }
  $("add-error").hidden = true;
  if (!path) return;
  if (!editing) {
    $("add-preview").hidden = false;
    $("add-preview").style.removeProperty("--label");
    $("pv-name").textContent = "Checking…";
    $("pv-version").textContent = "";
    $("pv-desc").textContent = "";
    $("pv-status").textContent = "";
  }
  try {
    const p = await api("POST", "/api/packages/inspect", { path, overrides });
    if (seq !== inspectSeq) return;
    preview = p;
    $("add-submit").disabled = false;
    renderPreview();
  } catch (err) {
    if (seq !== inspectSeq) return;
    if (!editing) $("add-preview").hidden = true;
    $("add-submit").disabled = editing;
    showAddError(err.message);
  }
}

// Opens the Add dialog, empty or with a path to check right away.
// `preset`: detected details to keep, such as the id when updating a package.
function openAdd(path = "", preset = {}) {
  resetPreview();
  overrides = { ...preset };
  for (const [key, id] of Object.entries(DETECTED_FIELDS)) $(id).value = preset[key] ?? "";
  $("add-detected").hidden = true;
  $("add-path").value = path;
  $("pick-folder").hidden = !desktop;
  $("add-select").checked = remember.get("autoSelect") !== "0";
  if (!$("add-dialog").open) $("add-dialog").showModal();
  if (path) void inspectNow();
  else $("add-path").focus();
}

// Where the native pickers open: the folder of the last pick of that kind.
// For a plugin that is the folder holding it, so the next version beside it
// is one click away.
const parentOf = (path) => path.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "") || path;
function lastDir(kind) {
  return remember.get(`dir:${kind}`) || undefined;
}
function rememberDir(kind, dir) {
  if (dir) remember.set(`dir:${kind}`, dir);
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

const PLUGIN_FILE = /\.(zip|zxp|ccx|jsx|jsxbin|jsfl|py)$/i;

// A dropped or picked file (or, in the desktop app, folder) opens the Add
// dialog with it. The desktop app knows its path; a browser uploads it first.
async function addFile(file) {
  const path = desktop?.pathForFile?.(file);
  if (path) return openAdd(path);
  if (!PLUGIN_FILE.test(file.name)) {
    toast("Drop a .zip, .zxp, .ccx, .jsx, .jsxbin, .jsfl or .py file. A folder works in the zeploy app, or type its path.", true);
    return;
  }
  try {
    const { path: uploaded } = await api("POST", `/api/packages/upload?name=${encodeURIComponent(file.name)}`, file);
    openAdd(uploaded);
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

// ---- Settings: admin computers and team token -------------------------------------------------

let tokenShown = false;
const bareUrl = (url) => url.replace(/^https?:\/\//, "");

// Every other admin computer: the ones added here and the ones PCs report
// (added on another admin), with how many PCs know and reach each.
function otherAdmins() {
  const urls = new Set(state.admins);
  for (const a of state.agents) for (const l of a.state?.admins ?? []) if (!l.current) urls.add(l.url);
  return [...urls].sort().map((url) => {
    const links = state.agents.map((a) => a.state?.admins?.find((l) => l.url === url)).filter(Boolean);
    return {
      url,
      addedHere: state.admins.includes(url),
      known: links.length,
      connected: links.filter((l) => l.status === "connected").length,
      rejected: links.filter((l) => l.status === "rejected").length,
    };
  });
}

function renderSettings() {
  const total = state.agents.length;
  const self = state.addresses.map((a) => `${a}:${state.port}`).join(", ") || `port ${state.port}`;
  const online = state.agents.filter((a) => a.online).length;
  const rows = [
    `<li class="admin-row"><span class="admin-url code">${esc(self)}</span>` +
      `<span class="admin-stat">this computer, ${online} of ${pcs(total)} connected</span></li>`,
    ...otherAdmins().map((o) => {
      const stat = o.rejected
        ? `${o.rejected} of ${pcs(o.known)} rejected: that computer uses another team token`
        : o.known
          ? `connected on ${o.connected} of ${pcs(o.known)}`
          : "no PC knows it yet";
      return (
        `<li class="admin-row"><span class="admin-url code">${esc(bareUrl(o.url))}</span>` +
        `<span class="admin-stat${o.rejected ? " err" : ""}">${esc(stat)}${o.addedHere ? "" : ", added on another admin"}</span>` +
        `<button type="button" class="link-btn" data-remove-admin="${esc(o.url)}" aria-label="Remove ${esc(bareUrl(o.url))}">Remove</button></li>`
      );
    }),
  ];
  $("admin-list").innerHTML = rows.join("");
  const old = state.agents.filter((a) => !(a.features ?? []).includes("admins")).length;
  $("admin-old-agents").hidden = old === 0;
  $("admin-old-agents").textContent = `${pcs(old)} run${old === 1 ? "s" : ""} an agent older than 0.7.0 and only connect${old === 1 ? "s" : ""} to the computer ${old === 1 ? "it was" : "they were"} set up for. Update their agents first.`;
  $("token-value").textContent = tokenShown ? state.enrollToken : "•".repeat(24);
  $("token-show").textContent = tokenShown ? "Hide" : "Show";
  $("usage-enabled").checked = state.usageEnabled;
  renderUsageDelete();
}

// Settings: whose usage to delete, and of which plugin.
function renderUsageDelete() {
  const pcSelect = $("usage-delete-pc");
  const plugin = $("usage-delete-plugin");
  const keepPc = pcSelect.value;
  const keepPlugin = plugin.value;
  pcSelect.replaceChildren(
    ...sortedAgents().map((a) => new Option(`${nameOf(a)}${a.role ? ` (${a.role})` : ""}`, a.id)),
    new Option("Every PC", "*"),
  );
  plugin.replaceChildren(new Option("Every plugin", ""), ...latestPackages().map((p) => new Option(p.name, p.id)));
  if ([...pcSelect.options].some((o) => o.value === keepPc)) pcSelect.value = keepPc;
  if ([...plugin.options].some((o) => o.value === keepPlugin)) plugin.value = keepPlugin;
}

async function deleteUsage(event) {
  event.preventDefault();
  const agent = $("usage-delete-pc").value;
  const pkgId = $("usage-delete-plugin").value;
  const pkg = latestPackages().find((p) => p.id === pkgId);
  const who = agent === "*" ? "every PC" : nameOf(state.agents.find((a) => a.id === agent) ?? { hostname: agent });
  const what = pkg ? pkg.name : "every plugin";
  const ok = await askConfirm({
    title: `Delete usage of ${what} on ${who}?`,
    body: "All collected days go, for good. New usage still comes in.",
    action: "Delete",
  });
  if (!ok) return;
  // A package's usage is stored under the plugin's own ids (its keys).
  const plugins = pkg ? [...new Set([pkg.id, ...[...packageKeys(pkg)].map((k) => k.slice(k.indexOf(":") + 1))])] : [""];
  try {
    let removed = 0;
    for (const plugin of plugins) {
      const query = `agent=${encodeURIComponent(agent)}${plugin ? `&plugin=${encodeURIComponent(plugin)}` : ""}`;
      removed += (await api("DELETE", `/api/usage?${query}`)).removed;
    }
    toast(removed ? `Deleted ${removed} day(s) of usage.` : "There was no usage to delete.");
    if (view === "dashboard") void loadDashboard();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---- Dashboard ----------------------------------------------------------------------------------
// Which plugins the team uses, from the daily totals PCs send (agent 0.8.0)
// for plugins that include the zeploy usage helper (docs/plugin-usage.md).
// One period filter scopes everything below it. Charts are single-series in
// --chart; every value is also in a table.

const DASH_PERIODS = [7, 30, 90];
let view = remember.get("view") === "dashboard" ? "dashboard" : "pcs";
let dashDays = DASH_PERIODS.includes(Number(remember.get("usageDays"))) ? Number(remember.get("usageDays")) : 30;
// cur: this period; wide: this period and the one before (for changes);
// all: 180 days (which plugins report usage at all).
const dash = { cur: null, wide: null, all: null, loading: false };
let usageOpen = null; // the plugin whose details are shown
let dashTimer = null;

// The package a plugin id belongs to: its id, or one of its plugin
// identities ("cep:com.colosave.panel" for "com.colosave.panel").
function packageForPlugin(id) {
  const low = id.toLowerCase();
  return latestPackages().find((p) => p.id === low || [...packageKeys(p)].some((k) => k.slice(k.indexOf(":") + 1) === low)) ?? null;
}

// The dashboard's role filter: the roles shown, by name ("No role" for PCs
// without one); empty means every role. Remembered per browser.
const NO_ROLE = "No role";
const roleOf = (agent) => agent.role || NO_ROLE;
let dashRoles = new Set(JSON.parse(remember.get("usageRoles") || "[]"));
const inScope = (agent) => dashRoles.size === 0 || dashRoles.has(roleOf(agent));
const scopedAgents = () => state.agents.filter(inScope);

function setRoles(roles) {
  dashRoles = new Set(roles);
  remember.set("usageRoles", JSON.stringify([...dashRoles]));
  void loadDashboard();
}

function installedOn(pkg) {
  return scopedAgents().filter((a) => a.state?.receipts.some((r) => r.id === pkg.id) || foundOn(a, pkg)).length;
}

// Role toggles: "All roles", then one per role with its number of PCs.
function renderRoleFilter() {
  const counts = new Map();
  for (const a of state.agents) counts.set(roleOf(a), (counts.get(roleOf(a)) ?? 0) + 1);
  const roles = [...counts.keys()].sort((a, b) => (a === NO_ROLE) - (b === NO_ROLE) || a.localeCompare(b));
  // A remembered role nobody has any more does not count.
  for (const r of [...dashRoles]) if (!counts.has(r)) dashRoles.delete(r);
  const el = $("dash-roles");
  el.hidden = roles.length < 2;
  const chip = (label, pressed, data, n) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "filter";
    b.setAttribute("aria-pressed", String(pressed));
    b.dataset.dashRole = data;
    b.append(label);
    if (n !== undefined) {
      const count = document.createElement("span");
      count.className = "n";
      count.textContent = String(n);
      b.append(" ", count);
    }
    return b;
  };
  el.replaceChildren(
    chip("All roles", dashRoles.size === 0, ""),
    ...roles.map((r) => chip(r, dashRoles.has(r), r, counts.get(r))),
  );
}

// The oldest version of a package that carries the usage helper, or null.
function helperSince(pkg) {
  const versions = state.packages.filter((p) => p.id === pkg.id && p.usageHelper).map((p) => p.version);
  return versions.sort(compareSemver)[0] ?? null;
}

// Copies of a plugin older than its first version with the usage helper,
// such as one installed by hand or under another package id. Its host may
// load that copy instead, which then reports nothing.
function olderCopies(pkg) {
  const since = helperSince(pkg);
  const versions = new Set();
  let count = 0;
  if (since) {
    const keys = packageKeys(pkg);
    for (const a of state.agents) {
      const copies = [
        ...(a.state?.found ?? []).filter((f) => keys.has(f.key)).map((f) => f.version ?? "0.0.0"),
        ...(a.state?.receipts ?? []).filter((r) => r.id === pkg.id).map((r) => r.version),
      ].filter((v) => compareSemver(v, since) < 0);
      if (copies.length) count++;
      for (const v of copies) versions.add(v);
    }
  }
  return { pcs: count, versions: [...versions].sort(compareSemver) };
}

// One row per package (or per plugin id zeploy has no package for).
function usageRows(data) {
  const rows = new Map();
  for (const u of data?.plugins ?? []) {
    const pkg = packageForPlugin(u.plugin);
    const key = pkg ? `pkg:${pkg.id}` : `id:${u.plugin.toLowerCase()}`;
    let r = rows.get(key);
    if (!r) {
      r = { key, pkg, name: pkg?.name ?? u.plugin, ids: [], opens: 0, uses: 0, errors: 0, errorKinds: {}, last: "", actions: {}, versions: {}, agents: {}, perDay: {} };
      rows.set(key, r);
    }
    r.ids.push(u.plugin);
    r.opens += u.opens;
    r.uses += u.uses;
    r.errors += u.errors;
    if (u.last > r.last) r.last = u.last;
    for (const [n, a] of Object.entries(u.actions)) {
      const t = (r.actions[n] ??= { n: 0, ms: 0 });
      t.n += a.n;
      t.ms += a.ms;
    }
    for (const [v, n] of Object.entries(u.versions)) r.versions[v] = (r.versions[v] ?? 0) + n;
    for (const [name, k] of Object.entries(u.errorKinds ?? {})) {
      const t = (r.errorKinds[name] ??= { n: 0, agents: [], versions: [], lastDay: "" });
      t.n += k.n;
      t.agents = [...new Set([...t.agents, ...k.agents])];
      t.versions = [...new Set([...t.versions, ...k.versions])];
      if (k.lastDay > t.lastDay) t.lastDay = k.lastDay;
    }
    for (const [id, a] of Object.entries(u.agents)) {
      const t = (r.agents[id] ??= { opens: 0, uses: 0, errors: 0, last: "" });
      t.opens += a.opens;
      t.uses += a.uses;
      t.errors += a.errors ?? 0;
      if (a.last > t.last) t.last = a.last;
    }
    for (const [day, d] of Object.entries(u.perDay ?? {})) {
      const t = (r.perDay[day] ??= { opens: 0, uses: 0, errors: 0 });
      t.opens += d.opens;
      t.uses += d.uses;
      t.errors += d.errors;
    }
  }
  for (const r of rows.values()) {
    // A plugin that reports features is used when they are; one that only
    // reports opening, when it is opened.
    r.byUses = r.uses > 0;
    r.count = r.byUses ? r.uses : r.opens;
    r.countOn = (day) => (r.byUses ? r.perDay[day]?.uses : r.perDay[day]?.opens) ?? 0;
    r.usedOn = Object.values(r.agents).filter((a) => (r.byUses ? a.uses : a.opens) > 0).length;
    r.installed = r.pkg ? installedOn(r.pkg) : null;
  }
  return [...rows.values()].sort((a, b) => b.usedOn - a.usedOn || b.count - a.count || a.name.localeCompare(b.name));
}

// "2026-10-20" and the days after it.
function dayList(from, n) {
  const [y, m, d] = from.split("-").map(Number);
  return Array.from({ length: n }, (_, i) => {
    const day = new Date(y, m - 1, d + i);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  });
}

const shortDay = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

// "today", "yesterday" or "27 Oct" for a "2026-10-27".
function dayWord(day) {
  return day === localDayKey(0) ? "today" : day === localDayKey(-1) ? "yesterday" : shortDay(day);
}

// "2026-10-28": the local day of `d`, or of today plus some days.
function dayKeyOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function localDayKey(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return dayKeyOf(d);
}

// Errors a plugin reported, one row per error name, most first. The name is
// the plugin's own (the feature that failed, or a short error kind): plugins
// send no messages, so the PCs and versions are what narrow it down.
function errorRows(r) {
  const agents = new Map(state.agents.map((a) => [a.id, a]));
  return Object.entries(r.errorKinds ?? {})
    .sort((a, b) => b[1].n - a[1].n)
    .map(([name, k]) => {
      const names = k.agents.map((id) => (agents.get(id) ? nameOf(agents.get(id)) : "Forgotten PC")).sort((a, b) => a.localeCompare(b));
      return { name, n: k.n, pcNames: names, versions: [...k.versions].sort((a, b) => compareSemver(b, a)), lastDay: k.lastDay };
    });
}

function errorTable(rows, withPlugin) {
  return (
    `<table class="mini errors"><thead><tr>${withPlugin ? "<th>Plugin</th>" : ""}<th>Error</th><th class="num">Count</th><th>PCs</th><th>Versions</th><th class="num">Last</th></tr></thead><tbody>` +
    rows
      .map(
        (e) =>
          `<tr>${withPlugin ? `<td>${esc(e.plugin)}</td>` : ""}<td class="err-name">${esc(e.name)}</td><td class="num err">${e.n}</td>` +
          `<td class="wrap" title="${esc(e.pcNames.join(", "))}">${esc(listText(e.pcNames))}</td>` +
          `<td class="wrap code">${esc(e.versions.join(", ")) || "–"}</td><td class="num muted">${esc(dayWord(e.lastDay))}</td></tr>`,
      )
      .join("") +
    `</tbody></table>`
  );
}

// 1,284 / 12.9K / 4.2M
function compact(n) {
  if (n < 10_000) return Math.round(n).toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

// A clean axis maximum whose half is clean too: 120, 150, 200, 300...
function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((x) => x >= v) ?? 10 * p;
}

// The change against the previous period of the same length.
function deltaHtml(cur, prev, upIsGood) {
  const period = `vs previous ${dashDays} days`;
  if (prev === 0) return cur ? `<span class="delta muted">none in the previous ${dashDays} days</span>` : "";
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return `<span class="delta muted">same as previous ${dashDays} days</span>`;
  const good = pct > 0 === upIsGood;
  return `<span class="delta ${good ? "good" : "bad"}">${pct > 0 ? "▲ +" : "▼ "}${pct}% <span class="muted">${period}</span></span>`;
}

// A trend in the quiet gray, the latest day marked in --chart.
function sparkline(values) {
  if (values.length < 2) return "";
  const w = 120;
  const h = 28;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (w - 8) + 4, h - 4 - (v / max) * (h - 8)]);
  const [lx, ly] = pts.at(-1);
  return (
    `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">` +
    `<polyline points="${pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ")}" />` +
    `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4" /></svg>`
  );
}

function tile(label, value, sub, extra = "") {
  return (
    `<div class="tile"><div class="tile-label">${label}</div>` +
    `<div class="tile-value">${value}${sub ? ` <span class="tile-sub">${sub}</span>` : ""}</div>${extra}</div>`
  );
}

// Uses per day: one series of columns, the busiest day labelled, a hover
// tooltip per day, and a table twin.
function columnChart(days, values) {
  const W = 760;
  const H = 190;
  const left = 40;
  const right = 8;
  const top = 18;
  const bottom = 24;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const max = niceMax(Math.max(...values));
  const band = plotW / days.length;
  const colW = Math.max(2, Math.min(24, band - 2));
  const y = (v) => top + plotH - (v / max) * plotH;
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Uses per day over ${days.length} days">`;
  for (const t of [0, max / 2, max]) {
    svg += `<line class="grid" x1="${left}" x2="${W - right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" />`;
    svg += `<text class="tick" x="${left - 6}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end">${compact(t)}</text>`;
  }
  const peak = values.indexOf(Math.max(...values));
  const labelEvery = Math.ceil(days.length / 7);
  days.forEach((day, i) => {
    const v = values[i];
    const x = left + i * band + (band - colW) / 2;
    if (v > 0) {
      svg += `<rect class="col" x="${x.toFixed(1)}" y="${y(v).toFixed(1)}" width="${colW.toFixed(1)}" height="${(top + plotH - y(v)).toFixed(1)}" />`;
    }
    if (i === peak && v > 0) {
      svg += `<text class="peak" x="${(x + colW / 2).toFixed(1)}" y="${(y(v) - 5).toFixed(1)}" text-anchor="middle">${compact(v)}</text>`;
    }
    if (i % labelEvery === 0) {
      svg += `<text class="tick" x="${(left + i * band + band / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(shortDay(day))}</text>`;
    }
    // The whole day's band is the hover target, bigger than the column.
    svg +=
      `<rect class="hit" x="${(left + i * band).toFixed(1)}" y="${top}" width="${band.toFixed(1)}" height="${plotH}" tabindex="0" ` +
      `data-tip-value="${v} ${v === 1 ? "use" : "uses"}" data-tip-title="${esc(shortDay(day))}" aria-label="${esc(shortDay(day))}: ${v} uses" />`;
  });
  svg += `<line class="axis" x1="${left}" x2="${W - right}" y1="${top + plotH}" y2="${top + plotH}" /></svg>`;
  const table =
    `<details class="details table-view"><summary>Show as table</summary><table class="usage compact"><thead><tr><th>Day</th><th>Uses</th></tr></thead><tbody>` +
    days.map((d, i) => `<tr><td>${esc(shortDay(d))}</td><td>${values[i]}</td></tr>`).join("") +
    `</tbody></table></details>`;
  return svg + table;
}

// Horizontal bars, longest first, the value at the tip.
function hbars(items, max) {
  if (!items.length) return `<p class="empty-line">Nothing in this period.</p>`;
  return (
    `<div class="hbars">` +
    items
      .map(
        (it) =>
          `<div class="hbar-row" tabindex="0" data-tip-title="${esc(it.name)}" data-tip-value="${esc(it.tip)}">` +
          `<span class="hbar-name" title="${esc(it.name)}">${esc(it.name)}</span>` +
          `<span class="hbar-track"><span class="hbar" style="--w:${(it.value / max).toFixed(3)}"></span>` +
          `<span class="hbar-val">${esc(it.label)}</span></span></div>`,
      )
      .join("") +
    `</div>`
  );
}

function usageDetails(r) {
  const agents = new Map(state.agents.map((a) => [a.id, a]));
  const actions = Object.entries(r.actions).sort((a, b) => b[1].n - a[1].n).slice(0, 10);
  const byRole = new Map();
  const pcsRows = Object.entries(r.agents)
    .map(([id, a]) => ({ agent: agents.get(id), ...a }))
    .sort((a, b) => b.uses - a.uses || b.opens - a.opens);
  for (const p of pcsRows) {
    const role = p.agent?.role || "No role";
    const t = byRole.get(role) ?? { pcs: 0, n: 0 };
    t.pcs++;
    t.n += r.byUses ? p.uses : p.opens;
    byRole.set(role, t);
  }
  const versions = Object.entries(r.versions).sort((a, b) => compareSemver(b[0], a[0]));
  const count = r.byUses ? "Uses" : "Opens";
  // One small table per section: a name column, then right-aligned numbers
  // under their own headings.
  const section = (title, heads, rows) =>
    `<div class="usage-col"><h4>${title}</h4>` +
    (rows.length
      ? `<table class="mini"><thead><tr>${heads.map((h, i) => `<th${i ? ` class="num"` : ""}>${h}</th>`).join("")}</tr></thead>` +
        `<tbody>${rows.map((cells) => `<tr>${cells.map((c, i) => `<td${i ? ` class="num"` : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`
      : `<p class="muted small">None reported.</p>`) +
    `</div>`;
  return (
    `<div class="usage-details">` +
    section(
      "Features",
      ["Feature", "Uses", "Avg time"],
      actions.map(([name, a]) => [esc(name), a.n, a.ms ? `${Math.round(a.ms / a.n)} ms` : `<span class="muted">–</span>`]),
    ) +
    section(
      "PCs",
      ["PC", count, "Last"],
      pcsRows.slice(0, 12).map((p) => [esc(p.agent ? nameOf(p.agent) : "Forgotten PC"), r.byUses ? p.uses : p.opens, `<span class="muted">${relTime(p.last)}</span>`]),
    ) +
    section(
      "Roles",
      ["Role", count, "PCs"],
      [...byRole].sort((a, b) => b[1].n - a[1].n).map(([role, t]) => [esc(role), t.n, t.pcs]),
    ) +
    section("Versions", ["Version", "Events"], versions.map(([v, n]) => [`<span class="code">${esc(v)}</span>`, n])) +
    (r.errors
      ? `<div class="usage-col usage-errors"><h4>Errors</h4>${errorTable(errorRows(r), false)}</div>`
      : "") +
    `</div>`
  );
}

function rankingTable(rows) {
  return (
    `<table class="usage ranking"><thead><tr><th class="rank">#</th><th>Plugin</th><th class="num" title="PCs that used it, of the PCs that have it">Used on PCs</th><th class="num">Uses</th><th class="num">Opens</th><th class="num">Errors</th><th class="num">Last used</th></tr></thead><tbody>` +
    rows
      .map((r, i) => {
        // "of N" only when zeploy knows where it is installed (by hand on more PCs is possible).
        const on = r.installed && r.installed >= r.usedOn ? `${r.usedOn} <span class="muted">of ${r.installed}</span>` : `${r.usedOn}`;
        const open = usageOpen === r.key;
        return (
          `<tr class="usage-row${open ? " open" : ""}" style="--label:${r.pkg ? labelFor(r.pkg.id) : "var(--line2)"}">` +
          `<td class="rank">${i + 1}</td>` +
          `<td><button type="button" class="usage-name" data-usage-row="${esc(r.key)}" aria-expanded="${open}">${esc(r.name)}</button>` +
          (r.pkg ? "" : `<span class="usage-sub" title="${esc(r.ids.join(", "))}">not in zeploy</span>`) +
          `</td><td class="num">${on}</td><td class="num">${r.byUses ? r.uses : `<span class="muted">–</span>`}</td><td class="num">${r.opens}</td>` +
          `<td class="num${r.errors ? " err" : " muted"}">${r.errors}</td><td class="num muted">${relTime(r.last)}</td></tr>` +
          (open ? `<tr class="usage-more"><td colspan="7">${usageDetails(r)}</td></tr>` : "")
        );
      })
      .join("") +
    `</tbody></table>`
  );
}

const box = (title, body, cls = "") => `<section class="box ${cls}"><h3 class="box-title">${title}</h3>${body}</section>`;

// Only the PCs with the roles shown, when not every role is.
function scopeParam() {
  if (dashRoles.size === 0 || !state) return "";
  return `&agents=${encodeURIComponent(scopedAgents().map((a) => a.id).join(","))}`;
}

function renderDashboard() {
  renderRoleFilter();
  $("dash-period").innerHTML = DASH_PERIODS.map(
    (d) => `<button type="button" class="filter" data-dash-days="${d}" aria-pressed="${dashDays === d}">Last ${d} days</button>`,
  ).join("");
  const reporting = scopedAgents().filter((a) => (a.features ?? []).includes("usage")).length;
  $("dash-note").textContent = `${pcs(reporting)} of ${scopedAgents().length} can report usage (agent 0.8.0)`;
  const el = $("dash-body");
  // A reload keeps the last picture, dimmed, instead of flashing.
  el.classList.toggle("stale", dash.loading && !!dash.cur);
  if (!state.usageEnabled) {
    el.innerHTML = `<p class="empty-line">Usage reporting is off. Switch it on under Settings.</p>`;
    return;
  }
  if (!dash.cur || !dash.wide || !dash.all) {
    if (!el.innerHTML) el.innerHTML = `<p class="empty-line">Loading…</p>`;
    return;
  }

  const rows = usageRows(dash.cur);
  const days = dayList(dash.cur.from, dashDays);
  const daily = days.map((d) => rows.reduce((n, r) => n + r.countOn(d), 0));
  const wide = usageRows(dash.wide);
  const prevDays = dayList(dash.wide.from, dash.wide.days - dashDays);
  const prevUses = prevDays.reduce((n, d) => n + wide.reduce((m, r) => m + r.countOn(d), 0), 0);
  const prevErrors = prevDays.reduce((n, d) => n + wide.reduce((m, r) => m + (r.perDay[d]?.errors ?? 0), 0), 0);
  const prevUsed = wide.filter((r) => prevDays.some((d) => r.countOn(d) > 0)).length;
  const all = usageRows(dash.all);

  const used = rows.filter((r) => r.usedOn > 0);
  const uses = daily.reduce((a, b) => a + b, 0);
  const errors = rows.reduce((n, r) => n + r.errors, 0);
  const pcsUsing = new Set(
    rows.flatMap((r) => Object.entries(r.agents).filter(([, a]) => (r.byUses ? a.uses : a.opens) > 0).map(([id]) => id)),
  ).size;

  const kpis =
    `<div class="kpis">` +
    tile("Plugins used", String(used.length), `of ${all.length} reporting`, deltaHtml(used.length, prevUsed, true)) +
    tile("Uses", compact(uses), "", deltaHtml(uses, prevUses, true) + sparkline(daily)) +
    tile("PCs using plugins", String(pcsUsing), `of ${scopedAgents().length}`) +
    tile("Errors", compact(errors), "", deltaHtml(errors, prevErrors, false)) +
    `</div>`;

  if (all.length === 0) {
    el.innerHTML =
      kpis +
      box(
        "No plugin reports usage yet",
        `<p class="muted small">Add the zeploy usage helper to a plugin (docs/plugin-usage-prompt.md is a ready prompt), or install the zeploy test panel 1.2.0 and use its button. PCs need agent 0.8.0.</p>`,
      );
    return;
  }

  const top = used.slice(0, 10);
  const pluginBars = hbars(
    top.map((r) => ({
      name: r.name,
      value: r.usedOn,
      label: `${pcs(r.usedOn)} · ${compact(r.count)}`,
      tip: `${pcs(r.usedOn)}, ${r.count} ${r.byUses ? "uses" : "opens"}`,
    })),
    Math.max(1, ...top.map((r) => r.usedOn)),
  );
  const roleUses = new Map();
  const agents = new Map(state.agents.map((a) => [a.id, a]));
  for (const r of rows) {
    for (const [id, a] of Object.entries(r.agents)) {
      const role = agents.get(id)?.role || "No role";
      roleUses.set(role, (roleUses.get(role) ?? 0) + (r.byUses ? a.uses : a.opens));
    }
  }
  const roles = [...roleUses].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const roleBars = hbars(
    roles.map(([name, n]) => ({ name, value: n, label: compact(n), tip: `${n} uses` })),
    Math.max(1, ...roles.map(([, n]) => n)),
  );

  // Not used: plugins that reported before but not in the period, and
  // packages with the usage helper that never reported a use. Not reporting:
  // packages without the helper.
  const reportingIds = new Set(all.filter((r) => r.pkg).map((r) => r.pkg.id));
  const idle = all.filter((r) => r.pkg && !used.some((u) => u.key === r.key));
  // Only packages on the PCs of the roles shown.
  const unreported = latestPackages().filter((p) => !reportingIds.has(p.id) && installedOn(p) > 0);
  const notYet = unreported.filter((p) => p.usageHelper);
  const silent = unreported.filter((p) => !p.usageHelper);
  const olderNote = (pkg) => {
    const older = olderCopies(pkg);
    const app = appGroup(pkg).key ? appGroup(pkg).title : "the app";
    return older.pcs
      ? `<span class="warn-note">${pcs(older.pcs)} ${older.pcs === 1 ? "has" : "have"} a copy without the usage helper (${esc(older.versions.join(", "))}); ${esc(app)} may load that one</span>`
      : "";
  };
  const idleList =
    idle.length || notYet.length
      ? `<ul class="plain">${idle
          .map(
            (r) =>
              `<li><span>${esc(r.name)}</span><span class="muted">on ${pcs(installedOn(r.pkg))}, last used ${relTime(r.last)}</span>${olderNote(r.pkg)}</li>`,
          )
          .join("")}${notYet
          .map(
            (p) =>
              `<li><span>${esc(p.name)}</span><span class="muted">on ${pcs(installedOn(p))}, reports usage since ${esc(helperSince(p))}; no use yet</span>${olderNote(p)}</li>`,
          )
          .join("")}</ul>`
      : `<p class="empty-line">Every plugin that reports usage was used.</p>`;
  const silentList = silent.length
    ? `<ul class="plain">${silent.map((p) => `<li><span>${esc(p.name)}</span><span class="muted">on ${pcs(installedOn(p))}</span></li>`).join("")}</ul>` +
      `<p class="muted small">Their ${esc(silent.length === 1 ? "version has" : "versions have")} no usage helper yet (docs/plugin-usage-prompt.md).</p>`
    : `<p class="empty-line">Every package reports usage.</p>`;

  // Every error in the period, by plugin and error name.
  const allErrors = rows
    .flatMap((r) => errorRows(r).map((e) => ({ ...e, plugin: r.name })))
    .sort((a, b) => b.n - a.n || b.lastDay.localeCompare(a.lastDay));
  const errorList = allErrors.length
    ? errorTable(allErrors, true) +
      `<p class="muted small">The error is the name the plugin gives it: the feature that failed, or a short kind. ` +
      `Plugins send no messages; the PC's own log or the plugin's console has those.</p>`
    : `<p class="empty-line">No errors reported in the last ${dashDays} days.</p>`;

  el.innerHTML =
    kpis +
    box("Uses per day", columnChart(days, daily)) +
    `<div class="two-up">` +
    box(`Most used plugins <span class="muted">· PCs using each</span>`, pluginBars) +
    box("Uses per role", roleBars) +
    `</div>` +
    `<div class="two-up">` +
    box(`Not used in the last ${dashDays} days`, idleList) +
    box("Not reporting usage", silentList) +
    `</div>` +
    box(`Errors <span class="muted">· ${compact(allErrors.reduce((n, e) => n + e.n, 0))} in the last ${dashDays} days</span>`, errorList) +
    box("All plugins", rankingTable(rows));
}

async function loadDashboard() {
  if (!state) return;
  dash.loading = true;
  renderDashboard();
  try {
    const [cur, wide, all] = await Promise.all([
      api("GET", `/api/usage?days=${dashDays}${scopeParam()}`),
      api("GET", `/api/usage?days=${Math.min(dashDays * 2, 180)}${scopeParam()}`),
      api("GET", `/api/usage?days=180${scopeParam()}`),
    ]);
    Object.assign(dash, { cur, wide, all });
  } catch (err) {
    toast(err.message, true);
  } finally {
    dash.loading = false;
  }
  if (view === "dashboard") renderDashboard();
}

function showView(next) {
  view = next;
  remember.set("view", view);
  $("pcs-view").hidden = view !== "pcs";
  $("dashboard").hidden = view !== "dashboard";
  $("view-pcs").setAttribute("aria-pressed", String(view === "pcs"));
  $("view-dashboard").setAttribute("aria-pressed", String(view === "dashboard"));
  hideTip();
  clearInterval(dashTimer);
  if (view === "dashboard") {
    void loadDashboard();
    dashTimer = setInterval(() => void loadDashboard(), 30_000);
  }
}

// One tooltip for every chart: the value leads, the label follows. Text goes
// in with textContent; names come from PCs and plugins.
function showTip(target, x, y) {
  const tip = $("chart-tip");
  const value = document.createElement("strong");
  value.textContent = target.dataset.tipValue;
  const title = document.createElement("span");
  title.textContent = target.dataset.tipTitle;
  tip.replaceChildren(value, title);
  tip.hidden = false;
  const main = document.querySelector(".main");
  const box = main.getBoundingClientRect();
  tip.style.left = `${Math.min(Math.max(x - box.left + 12, 4), box.width - tip.offsetWidth - 4)}px`;
  tip.style.top = `${y - box.top + main.scrollTop + 16}px`;
}

function hideTip() {
  $("chart-tip").hidden = true;
  document.querySelector(".tip-on")?.classList.remove("tip-on");
}

$("dash-body").addEventListener("pointermove", (event) => {
  const target = event.target.closest?.("[data-tip-value]");
  if (!target) return hideTip();
  document.querySelector(".tip-on")?.classList.remove("tip-on");
  target.classList.add("tip-on");
  showTip(target, event.clientX, event.clientY);
});
$("dash-body").addEventListener("pointerleave", hideTip);
$("dash-body").addEventListener("focusin", (event) => {
  const target = event.target.closest?.("[data-tip-value]");
  if (!target) return;
  const r = target.getBoundingClientRect();
  target.classList.add("tip-on");
  showTip(target, r.left + r.width / 2, r.top);
});
$("dash-body").addEventListener("focusout", hideTip);

function openSettings() {
  tokenShown = false;
  for (const id of ["admin-note", "admin-error", "token-error"]) $(id).hidden = true;
  $("token-join").open = false;
  $("token-input").value = "";
  renderSettings();
  $("settings-dialog").showModal();
}

async function addAdmin(event) {
  event.preventDefault();
  const address = $("admin-address").value.trim();
  $("admin-note").hidden = $("admin-error").hidden = true;
  if (!address) return;
  try {
    const { url, reachable } = await api("POST", "/api/admins", { address });
    $("admin-address").value = "";
    $("admin-note").textContent = reachable
      ? `Added ${bareUrl(url)}. PCs connect to it as well from now on.`
      : `Added ${bareUrl(url)}, but it does not answer now. PCs connect once its zeploy admin app runs.`;
    $("admin-note").hidden = false;
  } catch (err) {
    $("admin-error").textContent = err.message;
    $("admin-error").hidden = false;
  }
}

async function removeAdmin(url) {
  const ok = await askConfirm({
    title: `Remove ${bareUrl(url)}?`,
    body: "PCs stop connecting to that admin computer. Its packages and records stay on it, and plugins stay installed.",
    action: "Remove",
  });
  if (ok) await api("DELETE", `/api/admins?url=${encodeURIComponent(url)}`);
}

async function useToken(event) {
  event.preventDefault();
  const token = $("token-input").value.trim();
  $("token-error").hidden = true;
  if (!token || token === state.enrollToken) return;
  const ok = await askConfirm({
    title: "Use this team token?",
    body: "This computer joins the team of the admin computer the token comes from. PCs set up with the current token can no longer connect here.",
    action: "Use token",
  });
  if (!ok) return;
  try {
    await api("POST", "/api/team-token", { token });
    $("token-input").value = "";
    $("token-join").open = false;
    toast("Team token changed. Save the PC installer again before setting up PCs from here.");
  } catch (err) {
    $("token-error").textContent = err.message;
    $("token-error").hidden = false;
  }
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
  $("role-input").value = agent.role ?? "";
  $("role-list").innerHTML = roles().map((r) => `<option value="${esc(r)}"></option>`).join("");
  $("rename-error").hidden = true;
  $("rename-dialog").showModal();
  $("rename-input").select();
}

async function saveRename(label) {
  try {
    await api("POST", "/api/agents/rename", { id: renamingId, label, role: $("role-input").value.trim() });
    $("rename-dialog").close();
  } catch (err) {
    $("rename-error").textContent = err.message;
    $("rename-error").hidden = false;
  }
}

// ---- idle and error PCs: through the PC's waker --------------------------------------------

async function wakeAgent(button, id) {
  const agent = state.agents.find((a) => a.id === id);
  button.disabled = true;
  button.textContent = "Waking…";
  try {
    const r = await api("POST", "/api/agents/wake", { id });
    toast(`${agent ? nameOf(agent) : "PC"}: ${r.message}`, !r.started);
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Wake up";
  }
}

async function showLog(id) {
  const agent = state.agents.find((a) => a.id === id);
  const dialog = $("log-dialog");
  $("log-title").textContent = `Agent log${agent ? `: ${nameOf(agent)}` : ""}`;
  $("log-file").textContent = "Reading the log…";
  $("log-text").textContent = "";
  $("log-text").hidden = false;
  $("log-error").hidden = true;
  if (!dialog.open) dialog.showModal();
  try {
    const r = await api("POST", "/api/agents/log", { id });
    $("log-file").textContent = r.file;
    $("log-text").textContent = r.text || "The log is empty.";
    $("log-text").scrollTop = $("log-text").scrollHeight;
  } catch (err) {
    $("log-file").textContent = "";
    $("log-error").textContent = err.message;
    $("log-error").hidden = false;
    $("log-text").hidden = true;
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
    else if (d.updateAgent) await updateAgents([d.updateAgent]);
    else if (d.wake) await wakeAgent(el, d.wake);
    else if (d.showLog) await showLog(d.showLog);
    else if (d.copyLog !== undefined) await copy($("log-text").textContent, "Log copied");
    else if (d.removeAdmin) await removeAdmin(d.removeAdmin);
    else if (d.dashDays) {
      dashDays = Number(d.dashDays);
      remember.set("usageDays", String(dashDays));
      await loadDashboard();
    } else if (d.usageRow) {
      usageOpen = usageOpen === d.usageRow ? null : d.usageRow;
      renderDashboard();
    }
    else if (d.refreshPkg) await refreshPackage(d.refreshPkg);
    else if (d.close !== undefined) el.closest("dialog")?.close();
    else if (d.forget) {
      const { forget } = d;
      const agent = state.agents.find((a) => a.id === forget);
      const ok = await askConfirm({
        title: `Forget ${agent ? nameOf(agent) : "this PC"}?`,
        body: "It leaves the table. It comes back when its agent connects again, without the name you gave it.",
        action: "Forget",
      });
      if (ok) await api("DELETE", `/api/agents?id=${encodeURIComponent(forget)}`);
    } else if (d.removePkg) {
      const { removePkg: id, version } = d;
      const pkg = state.packages.find((p) => p.id === id && p.version === version);
      const installedOn = state.agents.filter((a) => a.state?.receipts.some((r) => r.id === id)).length;
      const ok = await askConfirm({
        title: `Delete ${pkg?.name ?? id} ${version}?`,
        body:
          `This version leaves the repository, so no PC can install it any more.` +
          (installedOn ? ` The ${pcs(installedOn)} that have the plugin keep it; use Remove to take it off them.` : ""),
        action: "Delete",
      });
      if (ok) await api("DELETE", `/api/packages?id=${encodeURIComponent(id)}&version=${encodeURIComponent(version)}`);
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
$("open-settings").addEventListener("click", () => state && openSettings());
$("view-pcs").addEventListener("click", () => showView("pcs"));
$("usage-delete-form").addEventListener("submit", deleteUsage);
// A role toggles on its own; "All roles" shows every role again.
$("dash-roles").addEventListener("click", (event) => {
  const role = event.target.closest?.("[data-dash-role]")?.dataset.dashRole;
  if (role === undefined) return;
  if (role === "") return setRoles([]);
  const next = new Set(dashRoles);
  if (next.has(role)) next.delete(role);
  else next.add(role);
  setRoles(next);
});
$("view-dashboard").addEventListener("click", () => showView("dashboard"));
$("usage-enabled").addEventListener("change", async () => {
  const usage = $("usage-enabled").checked;
  if (!usage) {
    const ok = await askConfirm({
      title: "Switch plugin usage off?",
      body: "PCs stop reporting and delete what plugins wrote. Usage already collected stays.",
      action: "Switch off",
    });
    if (!ok) {
      $("usage-enabled").checked = true;
      return;
    }
  }
  try {
    await api("POST", "/api/settings", { usage });
  } catch (err) {
    toast(err.message, true);
  }
});
$("admin-add-form").addEventListener("submit", addAdmin);
$("token-form").addEventListener("submit", useToken);
$("token-show").addEventListener("click", () => {
  tokenShown = !tokenShown;
  renderSettings();
});
$("token-copy").addEventListener("click", () => copy(state.enrollToken, "Team token copied."));

// Single-key shortcuts, as in a terminal app (listed in the status bar).
// Never while typing or while a dialog is open.
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  if (document.querySelector("dialog[open]") || event.target.closest?.("input, textarea, select")) return;
  const showTab = (name) => () => {
    if (sideCollapsed) setSideCollapsed(false);
    tab = name;
    render();
  };
  const act = {
    a: () => openAdd(),
    c: () => state && openConnect(),
    1: showTab("changes"),
    2: showTab("activity"),
    s: () => setSideCollapsed(!sideCollapsed),
    d: () => showView("dashboard"),
    u: () => showView("dashboard"),
    p: () => showView("pcs"),
  }[event.key];
  if (!act) return;
  event.preventDefault();
  act();
});
$("add-package").addEventListener("click", () => openAdd());
$("do-install").addEventListener("click", () => runAction("install"));
$("do-uninstall").addEventListener("click", () => runAction("uninstall"));
$("clear-selection").addEventListener("click", () => {
  selection.clear();
  render();
});
$("update-agents").addEventListener("click", () =>
  updateAgents(agentsToUpdate().map((a) => a.id)).catch((err) => toast(err.message, true)),
);

$("add-path").addEventListener("input", () => {
  overrides = {};
  clearTimeout(inspectTimer);
  inspectTimer = setTimeout(() => inspectNow(), 350);
});
$("pick-folder").addEventListener("click", async () => {
  const path = await desktop?.pickFolder("Choose a plugin folder", lastDir("add"));
  if (path) rememberDir("add", parentOf(path));
  if (path) openAdd(path);
});
$("pick-file").addEventListener("click", async () => {
  if (!desktop?.pickFile) return $("file-input").click();
  const path = await desktop.pickFile("Choose a plugin file", lastDir("add"));
  if (path) rememberDir("add", parentOf(path));
  if (path) openAdd(path);
});
$("file-input").addEventListener("change", () => {
  const file = $("file-input").files[0];
  $("file-input").value = "";
  if (file) void addFile(file);
});
for (const [key, id] of Object.entries(DETECTED_FIELDS)) {
  $(id).addEventListener("input", () => {
    overrides[key] = $(id).value;
    clearTimeout(inspectTimer);
    inspectTimer = setTimeout(() => inspectNow(true), 350);
  });
}
$("add-select").addEventListener("change", () => remember.set("autoSelect", $("add-select").checked ? "1" : "0"));
$("add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const path = $("add-path").value.trim();
  if (!path) {
    showAddError("Enter the path of a plugin folder or file.");
    return;
  }
  clearTimeout(inspectTimer);
  $("add-submit").disabled = true;
  try {
    const record = await api("POST", "/api/packages/import", { path, overrides });
    if (desktop) rememberDir("add", parentOf(path));
    $("add-dialog").close();
    afterAdd(record, $("add-select").checked);
  } catch (err) {
    showAddError(err.message);
  } finally {
    $("add-submit").disabled = preview?.status === "conflict" || preview?.status === "incomplete";
  }
});

$("pick-installer-folder").addEventListener("click", async () => {
  const path = await desktop?.pickFolder("Choose where to save the installer", $("installer-folder").value.trim() || lastDir("installer"));
  rememberDir("installer", path);
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

// Drag a plugin file (or, in the desktop app, folder) anywhere onto the window to add it.
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
  if (file) void addFile(file);
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
    const first = !state;
    state = JSON.parse(event.data);
    if (pendingSelect && state.packages.some((p) => p.id === pendingSelect.id && p.version === pendingSelect.version)) {
      selectForApps(pendingSelect.id, pendingSelect.apps);
      pendingSelect = null;
    }
    render();
    if (first && view === "dashboard") void loadDashboard();
  });
  events.addEventListener("log", (event) => {
    const { jobId, line } = JSON.parse(event.data);
    if (jobId === openJobId) {
      openJobLog.push(line);
      renderOpenLog();
    }
  });
}

showView(view);
connectEvents();
// Relative times ("5 min ago") age without server events.
setInterval(render, 30_000);
