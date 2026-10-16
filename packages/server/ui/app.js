"use strict";

// zdeploy admin UI. Plain browser JavaScript, no build step: the server serves
// this file as is, both to the Electron window and to a browser on this PC.

const token = document.querySelector('meta[name="admin-token"]').content;
// Present only inside the Electron app (see packages/admin/preload.cjs).
const desktop = window.zdeployDesktop ?? null;

// After Effects' layer label colors, one per package.
const LABELS = ["#E4D84C", "#A9CBC7", "#677DE0", "#E8920D", "#E5BCC9", "#4AA44C", "#A9A9CA", "#3DA2A5", "#F46DD6", "#E7C19E", "#B3C7B3", "#A89677"];
const APP_NAMES = { aftereffects: "AE", premiere: "Premiere", animate: "Animate" };
const STATUS = { queued: "Queued", sent: "Sent", running: "Running", done: "Done", failed: "Failed" };
const ACTIVE = new Set(["queued", "sent", "running"]);

let state = null;
const selection = new Map(); // key -> { agentId, packageId }
let openJobId = null;
let openJobLog = [];

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cellKey = (agentId, packageId) => `${agentId}|${packageId}`;
const pcs = (n) => `${n} ${n === 1 ? "PC" : "PCs"}`;
// The name the admin gave a PC, else its Windows computer name.
const nameOf = (agent) => agent.label || agent.hostname;

async function api(method, path, body) {
  const init = { method, headers: { "x-zdeploy-admin": token } };
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

// The address team PCs use: the one picked in Connect a PC, else the first.
function serverAddress() {
  const picked = $("setup-address").value;
  const host = picked || state.addresses[0] || "this-computer-ip";
  return `${host}:${state.port}`;
}

// Per-viewer convenience only; the page works without it.
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

async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast("Couldn't copy to the clipboard. Copy it from the screen instead.", true);
  }
}

// ---- rendering --------------------------------------------------------------------

function renderServer() {
  const online = state.agents.filter((a) => a.online).length;
  const addresses = state.addresses.length
    ? state.addresses.map((a) => `<strong>${esc(a)}:${state.port}</strong>`).join(", ")
    : "<strong>no network</strong>";
  $("server-info").innerHTML =
    `<span>Server ${addresses}</span>` +
    `<span>${online} of ${pcs(state.agents.length)} online</span>` +
    `<button type="button" class="link" id="copy-token">Copy team token</button>`;
}

function agentApps(agent) {
  const s = agent.state;
  if (!s) return "Not reported yet";
  const parts = s.adobe.map((a) => `${APP_NAMES[a.app] ?? a.app} ${a.version}`);
  if (s.blender.length) parts.push(`Blender ${s.blender.join(", ")}`);
  return parts.join(", ") || "No target apps found";
}

function cellHtml(agent, pkg, color) {
  const receipt = agent.state?.receipts.find((r) => r.id === pkg.id);
  const jobs = state.jobs.filter((j) => j.agentId === agent.id && j.packageId === pkg.id);
  const busy = jobs.find((j) => ACTIVE.has(j.status));
  const last = jobs.find((j) => !ACTIVE.has(j.status));
  const failed = !busy && last?.status === "failed";

  let cls = receipt ? (compareSemver(receipt.version, pkg.version) >= 0 ? "current" : "old") : "none";
  if (busy) cls = `${cls === "none" ? "old" : cls} busy`;
  const caption = busy ? STATUS[busy.status] : failed ? "Failed" : receipt ? receipt.version : "";
  const label =
    `${pkg.name} on ${nameOf(agent)}: ` +
    (receipt ? `version ${receipt.version} installed` : "not installed") +
    (busy ? `, ${STATUS[busy.status].toLowerCase()}` : failed ? ", last job failed" : "");
  const pressed = selection.has(cellKey(agent.id, pkg.id));
  return (
    `<td class="cell" style="--label:${color}">` +
    `<button type="button" data-agent="${esc(agent.id)}" data-pkg="${esc(pkg.id)}" aria-pressed="${pressed}" aria-label="${esc(label)}" title="${esc(label)}">` +
    `<span class="key ${cls}"></span><span class="ver${failed ? " failed" : ""}">${esc(caption)}</span>` +
    `</button></td>`
  );
}

function renderMatrix() {
  const pkgs = latestPackages();
  const agents = [...state.agents].sort((a, b) => b.online - a.online || nameOf(a).localeCompare(nameOf(b)));
  const matrix = $("matrix");

  if (agents.length === 0) {
    matrix.innerHTML =
      `<div class="empty"><h3>No PCs connected yet</h3>` +
      `<p>Install zdeploy-agent on each team PC. A PC appears here as soon as its agent connects to this computer.</p>` +
      `<button type="button" class="primary" data-open="connect">Connect a PC</button>` +
      (pkgs.length === 0 ? ` <button type="button" data-open="add">Add package</button>` : "") +
      `</div>`;
    return;
  }

  const head = pkgs
    .map((p) => {
      const color = labelFor(p.id);
      return (
        `<th scope="col" style="--label:${color}">` +
        `<button type="button" class="col-head" data-col="${esc(p.id)}" title="Select or clear every PC for ${esc(p.name)}">` +
        `<span class="name">${esc(p.name)}</span><span class="ver">${esc(p.version)}</span></button>` +
        `<div class="col-tools"><button type="button" class="link" data-remove-pkg="${esc(p.id)}" data-version="${esc(p.version)}">Remove from repository</button></div>` +
        `</th>`
      );
    })
    .join("");

  const rows = agents
    .map((a) => {
      const status = a.online ? "online" : `last seen ${relTime(a.lastSeen)}`;
      const warn =
        a.online && a.state && !a.state.isAdmin
          ? `<div class="warn">Agent runs without administrator rights; packages that go to Program Files will fail</div>`
          : "";
      const forget = a.online ? "" : ` <button type="button" class="link" data-forget="${esc(a.id)}">Forget PC</button>`;
      const windowsName = a.label ? `<span class="hostname">${esc(a.hostname)}</span>` : "";
      const cells = pkgs.map((p) => cellHtml(a, p, labelFor(p.id))).join("");
      return (
        `<tr class="${a.online ? "" : "offline"}"><th scope="row" class="row-head">` +
        `<div class="host"><span class="dot${a.online ? " on" : ""}"></span>${esc(nameOf(a))}${windowsName}` +
        `<button type="button" class="link rename" data-rename="${esc(a.id)}" aria-label="Rename ${esc(nameOf(a))}">Rename</button></div>` +
        `<div class="sub">${esc(a.user)}, ${esc(a.address)}, ${esc(status)}${forget}</div>` +
        `<div class="sub">${esc(agentApps(a))}</div>${warn}</th>${cells}</tr>`
      );
    })
    .join("");

  const table =
    `<table class="grid"><thead><tr><th class="corner" scope="col">${pcs(agents.length)}</th>${head}</tr></thead>` +
    `<tbody>${rows}</tbody></table>`;
  matrix.innerHTML =
    pkgs.length === 0
      ? table +
        `<div class="empty"><h3>No packages yet</h3>` +
        `<p>Add a plugin folder that contains zdeploy.json. Its column appears here, and you pick the PCs to install it on.</p>` +
        `<button type="button" class="primary" data-open="add">Add package</button></div>`
      : table +
        `<div class="legend"><span><i class="key current"></i>Latest version installed</span>` +
        `<span><i class="key old"></i>Older version installed</span>` +
        `<span>Click a cell to select it, or a package name to select every PC</span></div>`;
}

function selectionGroups() {
  const pkgs = new Map(latestPackages().map((p) => [p.id, p]));
  const groups = new Map();
  for (const { agentId, packageId } of selection.values()) {
    const pkg = pkgs.get(packageId);
    const agent = state.agents.find((a) => a.id === agentId);
    if (!pkg || !agent) continue;
    if (!groups.has(packageId)) groups.set(packageId, { pkg, agents: [] });
    groups.get(packageId).agents.push(agent);
  }
  return [...groups.values()];
}

function renderActionbar() {
  const groups = selectionGroups();
  for (const key of [...selection.keys()]) {
    const { agentId, packageId } = selection.get(key);
    if (!groups.some((g) => g.pkg.id === packageId && g.agents.some((a) => a.id === agentId))) selection.delete(key);
  }
  $("actionbar").hidden = groups.length === 0;
  $("selection-summary").textContent = groups
    .map((g) => `${g.pkg.name} ${g.pkg.version} for ${g.agents.map(nameOf).join(", ")}`)
    .join("; ");
}

function renderJobs() {
  const list = $("jobs");
  if (state.jobs.length === 0) {
    list.innerHTML = `<li class="empty"><p>No activity yet. Select cells in the table, then press Install.</p></li>`;
    return;
  }
  const hosts = new Map(state.agents.map((a) => [a.id, nameOf(a)]));
  const names = new Map(state.packages.map((p) => [p.id, p.name]));
  list.innerHTML = state.jobs
    .map((j) => {
      const verb = j.action === "install" ? "Install" : "Remove";
      const what = `${verb} ${names.get(j.packageId) ?? j.packageId}${j.version ? ` ${j.version}` : ""} on ${hosts.get(j.agentId) ?? "unknown PC"}`;
      const open = j.id === openJobId;
      const error = j.error ? `<span class="job-error">${esc(j.error.split("\n")[0])}</span>` : "";
      const detail = open
        ? `<div class="job-detail"><pre class="log" id="open-log"></pre>` +
          (j.status === "queued" ? `<button type="button" data-cancel="${esc(j.id)}">Cancel job</button>` : "") +
          `</div>`
        : "";
      return (
        `<li><button type="button" class="job-line" data-job="${esc(j.id)}" aria-expanded="${open}">` +
        `<span class="status ${j.status}">${STATUS[j.status]}</span><span>${esc(what)}</span>` +
        `<span class="job-time">${esc(relTime(j.createdAt))}</span>${error}</button>${detail}</li>`
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

// Re-rendering replaces the buttons; keep keyboard focus on the same one.
function focusKey() {
  const el = document.activeElement;
  if (!el || !el.dataset) return null;
  for (const attr of ["agent", "col", "job", "rename"]) {
    if (el.dataset[attr]) return `[data-${attr}="${CSS.escape(el.dataset[attr])}"]${el.dataset.pkg ? `[data-pkg="${CSS.escape(el.dataset.pkg)}"]` : ""}`;
  }
  return null;
}

function render() {
  if (!state) return;
  const focus = focusKey();
  renderServer();
  renderMatrix();
  renderActionbar();
  renderJobs();
  if (focus) document.querySelector(focus)?.focus();
}

// ---- actions --------------------------------------------------------------------------

function toggleCell(agentId, packageId) {
  const key = cellKey(agentId, packageId);
  if (selection.has(key)) selection.delete(key);
  else selection.set(key, { agentId, packageId });
  render();
}

function toggleColumn(packageId) {
  const keys = state.agents.map((a) => cellKey(a.id, packageId));
  const all = keys.every((k) => selection.has(k));
  for (const a of state.agents) {
    const k = cellKey(a.id, packageId);
    if (all) selection.delete(k);
    else selection.set(k, { agentId: a.id, packageId });
  }
  render();
}

async function runAction(action) {
  const options = { ifRunning: $("if-running").value, replaceDevLinks: $("replace-dev-links").checked };
  let sent = 0;
  const skipped = [];
  try {
    for (const g of selectionGroups()) {
      let agents = g.agents;
      if (action === "uninstall") {
        agents = agents.filter((a) => a.state?.receipts.some((r) => r.id === g.pkg.id));
        skipped.push(...g.agents.filter((a) => !agents.includes(a)).map((a) => `${g.pkg.name} on ${nameOf(a)}`));
      }
      if (agents.length === 0) continue;
      await api("POST", "/api/jobs", {
        action,
        packageId: g.pkg.id,
        version: action === "install" ? g.pkg.version : undefined,
        agentIds: agents.map((a) => a.id),
        options,
      });
      sent += agents.length;
    }
  } catch (err) {
    toast(err.message, true);
    return;
  }
  selection.clear();
  render();
  if (sent === 0) toast("That package isn't installed on the selected PCs.", true);
  else toast(`${action === "install" ? "Install" : "Removal"} sent to ${pcs(sent)}.` + (skipped.length ? `\nSkipped (not installed): ${skipped.join(", ")}` : ""));
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

async function addPackage(path) {
  const record = await api("POST", "/api/packages/import", { path });
  toast(`Added ${record.name} ${record.version}`);
}

async function uploadZip(file) {
  if (!/\.zip$/i.test(file.name)) {
    toast("Only .zip files can be added by drag and drop.", true);
    return;
  }
  try {
    const record = await api("POST", "/api/packages/upload", file);
    toast(`Added ${record.name} ${record.version}`);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderSetupCommand() {
  // ".\" so PowerShell runs the exe from the current folder (cmd accepts it too).
  $("setup-command").textContent = `.\\zdeploy-agent.exe setup --server ${serverAddress()} --token ${state.enrollToken}`;
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
  const error = $("installer-error");
  error.textContent = state.installerReady
    ? ""
    : "The admin app has no zdeploy-agent.exe to hand out yet. Run npm run build:agent, then npm run admin.";
  error.hidden = state.installerReady;

  renderSetupCommand();
  $("port-hint").textContent = String(state.port);
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
    result.textContent = `Saved "Install zdeploy agent.cmd" and zdeploy-agent.exe in ${folder}`;
    result.hidden = false;
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    $("save-installer").disabled = !state.installerReady;
  }
}

function openAdd() {
  $("add-error").hidden = true;
  $("pick-folder").hidden = !desktop;
  $("add-dialog").showModal();
  $("add-path").focus();
}

let renamingId = null;

function openRename(agentId) {
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) return;
  renamingId = agentId;
  $("rename-hint").textContent =
    `Only zdeploy shows this name. The PC's Windows name stays ${agent.hostname}.`;
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

$("rename-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void saveRename($("rename-input").value.trim());
});
$("rename-reset").addEventListener("click", () => void saveRename(""));
$("rename-cancel").addEventListener("click", () => $("rename-dialog").close());

document.addEventListener("click", async (event) => {
  const el = event.target.closest("button");
  if (!el) return;
  const d = el.dataset;
  try {
    if (d.agent && d.pkg) toggleCell(d.agent, d.pkg);
    else if (d.col) toggleColumn(d.col);
    else if (d.job) await toggleJob(d.job);
    else if (d.open === "connect") openConnect();
    else if (d.open === "add") openAdd();
    else if (d.cancel) await api("POST", `/api/jobs/cancel?id=${encodeURIComponent(d.cancel)}`);
    else if (d.rename) openRename(d.rename);
    else if (d.forget) {
      const agent = state.agents.find((a) => a.id === d.forget);
      const host = agent ? nameOf(agent) : "this PC";
      if (confirm(`Forget ${host}? It reappears when its agent connects again.`)) {
        await api("DELETE", `/api/agents?id=${encodeURIComponent(d.forget)}`);
      }
    } else if (d.removePkg) {
      if (confirm(`Remove ${d.removePkg} ${d.version} from the repository? Plugins already installed on PCs stay installed.`)) {
        await api("DELETE", `/api/packages?id=${encodeURIComponent(d.removePkg)}&version=${encodeURIComponent(d.version)}`);
      }
    } else if (el.id === "copy-token") await copy(state.enrollToken, "Team token copied.");
  } catch (err) {
    toast(err.message, true);
  }
});

$("connect-pc").addEventListener("click", () => state && openConnect());
$("add-package").addEventListener("click", openAdd);
$("copy-setup").addEventListener("click", () => copy($("setup-command").textContent, "Command copied."));
$("clear-selection").addEventListener("click", () => {
  selection.clear();
  render();
});
$("do-install").addEventListener("click", () => runAction("install"));
$("do-uninstall").addEventListener("click", () => runAction("uninstall"));
$("pick-folder").addEventListener("click", async () => {
  const path = await desktop?.pickFolder("Choose a package folder (with zdeploy.json)");
  if (path) $("add-path").value = path;
});
$("pick-installer-folder").addEventListener("click", async () => {
  const path = await desktop?.pickFolder("Choose where to save the installer");
  if (path) $("installer-folder").value = path;
});
$("save-installer").addEventListener("click", saveInstaller);
// Enter would otherwise submit the dialog's form and close it.
$("installer-folder").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  void saveInstaller();
});
$("setup-address").addEventListener("change", renderSetupCommand);

$("add-cancel").addEventListener("click", () => $("add-dialog").close());
$("add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const path = $("add-path").value.trim();
  const error = $("add-error");
  if (!path) {
    error.textContent = "Enter the path of a package folder or .zip file.";
    error.hidden = false;
    return;
  }
  $("add-submit").disabled = true;
  try {
    await addPackage(path);
    $("add-dialog").close();
    $("add-path").value = "";
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    $("add-submit").disabled = false;
  }
});

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

// ---- live updates -------------------------------------------------------------------

function connectEvents() {
  const events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  events.addEventListener("open", () => ($("banner").hidden = true));
  events.addEventListener("error", () => {
    $("banner").textContent = "Lost the connection to the admin server. Reconnecting…";
    $("banner").hidden = false;
  });
  events.addEventListener("state", (event) => {
    state = JSON.parse(event.data);
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
