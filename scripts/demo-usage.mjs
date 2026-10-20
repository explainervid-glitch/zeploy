// Sample data for trying the admin dashboard without real PCs:
//   node scripts/demo-usage.mjs [folder]   (default .zeploy-test/demo-data)
//   npm run server -- --host 127.0.0.1 --port 7422 --data .zeploy-test/demo-data
// Writes state.json (7 PCs with roles, 6 packages) and usage.json (60 days),
// replacing what is in the folder. Never point it at a real admin data folder.

import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? ".zeploy-test/demo-data";
fs.mkdirSync(dir, { recursive: true });

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pad = (n) => String(n).padStart(2, "0");
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();

const packages = [
  ["zeploy-test-panel", "zeploy test panel", "1.2.0", ["cep:com.zeploy.testpanel"], ["aftereffects"], "com.zeploy.testpanel"],
  ["colosave", "Colosave", "1.4.0", ["cep:com.colosave.panel"], ["aftereffects", "premiere"], "com.colosave.panel"],
  ["aegroup", "Aegroup", "2.1.0", ["ae-script:aegroup.jsx"], ["aftereffects"], "Aegroup.jsx"],
  ["remaper", "Remaper", "1.3.2", ["blender:remaper"], ["blender"], "remaper"],
  ["figblend", "Figblend", "0.2.0", ["blender:figblend"], ["blender"], "figblend"],
  ["delayerz", "DelayerZ", "1.1.0", ["jsfl:delayerz.jsfl"], ["animate"], null],
];
const agents = [
  ["demo-anim-01", "ANIM-01", "Animator"],
  ["demo-anim-02", "ANIM-02", "Animator"],
  ["demo-anim-03", "ANIM-03", "Animator"],
  ["demo-comp-01", "COMP-01", "Compositor"],
  ["demo-comp-02", "COMP-02", "Compositor"],
  ["demo-3d-01", "3D-01", "3D"],
  ["demo-3d-02", "3D-02", "3D"],
];
// Who has what installed, and how keen they are (uses per working day).
const habits = {
  "com.zeploy.testpanel": { pcs: ["demo-anim-01", "demo-comp-01"], rate: 1.5, actions: ["try"], app: "aftereffects", ver: "1.2.0", opens: 1 },
  "com.colosave.panel": { pcs: ["demo-anim-01", "demo-anim-02", "demo-anim-03", "demo-comp-01", "demo-comp-02"], rate: 9, actions: ["save", "apply", "export"], app: "aftereffects", ver: "1.4.0", opens: 2 },
  "Aegroup.jsx": { pcs: ["demo-anim-02", "demo-comp-02"], rate: 4, actions: ["group"], app: "aftereffects", ver: "2.1.0", opens: 0 },
  remaper: { pcs: ["demo-3d-01", "demo-3d-02"], rate: 6, actions: ["remap", "bake"], app: "blender", ver: "1.3.2", opens: 0 },
  figblend: { pcs: ["demo-3d-01"], rate: 2, actions: ["import"], app: "blender", ver: "0.2.0", opens: 0, until: 40 },
};

const iso = now.toISOString();
const state = {
  version: 1,
  enrollToken: "demo-token-demo-token-demo",
  packages: packages.map(([id, name, version, keys, apps]) => ({
    id, name, version, sha256: "0".repeat(64), size: 1, file: `${id}-${version}.zip`, addedAt: iso,
    components: [], keys, apps,
  })),
  agents: Object.fromEntries(
    agents.map(([id, hostname, role]) => {
      const receipts = packages
        .filter(([pid, , , , , plugin]) => (plugin ? habits[plugin].pcs.includes(id) : id.startsWith("demo-anim")))
        .map(([pid, , version]) => ({ id: pid, version, installedAt: iso }));
      return [id, {
        id, role, hostname, user: "demo", agentVersion: "0.8.0", features: ["self-update", "admins", "usage"],
        address: "192.168.1.1", firstSeen: iso, lastSeen: iso,
        state: { isAdmin: true, adobe: [{ app: "aftereffects", version: "2025" }], blender: ["4.2"], receipts, found: [] },
      }];
    }),
  ),
  jobs: [],
  usage: true,
};

const usage = { version: 1, days: {} };
for (let back = 59; back >= 0; back--) {
  const d = new Date(now.getTime() - back * 864e5);
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  const day = dayOf(d);
  for (const [plugin, h] of Object.entries(habits)) {
    if (h.until !== undefined && back < h.until) continue;
    for (const pc of h.pcs) {
      // A slow rise over the 60 days, quieter weekends, some days off.
      const n = Math.round(h.rate * (weekend ? 0.15 : 1) * (0.6 + rand() * 0.9) * (1 + (59 - back) / 120));
      if (n === 0 || rand() < 0.12) continue;
      const actions = {};
      for (let i = 0; i < n; i++) {
        const name = h.actions[Math.floor(rand() * h.actions.length)];
        const a = (actions[name] ??= { n: 0, ms: 0 });
        a.n++;
        a.ms += Math.round(200 + rand() * 1800);
      }
      const errors = rand() < 0.08 ? { [h.actions[0]]: 1 } : {};
      const row = { plugin, app: h.app, opens: h.opens, actions, errors, versions: { [h.ver]: n + h.opens }, last: new Date(`${day}T15:00:00`).toISOString() };
      ((usage.days[day] ??= {})[pc] ??= []).push(row);
    }
  }
}
fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2));
fs.writeFileSync(path.join(dir, "usage.json"), JSON.stringify(usage));
console.log(`demo data in ${dir}: ${Object.keys(usage.days).length} days`);
