// CEP panels (After Effects, Premiere Pro, Animate).
//
// A panel is a folder with CSXS/manifest.xml. It goes into one of two
// extensions folders: the all-users one under Common Files (needs admin) or
// the per-user one under %APPDATA%. Adobe apps load both, so the same panel in
// both is a conflict and the extra copy is removed, unless it is a developer
// link, which is never touched.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { emptyResult, PlanError, type HandlerResult, type PlanContext } from "../actions.ts";
import { APP_LABELS, APP_PROCESSES, CEP_HOSTS, type AdobeAppId } from "../env.ts";
import { linkTarget, pathExists } from "../fsutil.ts";
import type { CepComponent } from "../manifest.ts";

// One PlayerDebugMode key per CEP runtime version. Adobe adds a version with
// most releases, so the range runs ahead of what current apps use.
export const CSXS_VERSIONS = Array.from({ length: 16 }, (_, i) => 9 + i);

export interface CepInfo {
  bundleId: string;
  version: string | null;
  hosts: AdobeAppId[];
}

export async function readCepManifest(panelDir: string): Promise<CepInfo> {
  const file = join(panelDir, "CSXS", "manifest.xml");
  const xml = await readFile(file, "utf8");
  const bundleId = /ExtensionBundleId\s*=\s*"([^"]+)"/.exec(xml)?.[1];
  if (!bundleId) throw new PlanError(`no ExtensionBundleId in ${file}`);
  const version = /ExtensionBundleVersion\s*=\s*"([^"]+)"/.exec(xml)?.[1] ?? null;
  const hosts = new Set<AdobeAppId>();
  for (const m of xml.matchAll(/<Host\s+[^>]*Name\s*=\s*"([A-Z]+)"/g)) {
    const app = m[1] ? CEP_HOSTS[m[1]] : undefined;
    if (app) hosts.add(app);
  }
  return { bundleId, version, hosts: [...hosts] };
}

export async function planCep(c: CepComponent, ctx: PlanContext): Promise<HandlerResult> {
  const { env, options } = ctx;
  const result = emptyResult();
  const source = join(ctx.root, c.source);
  const info = await readCepManifest(source);
  const installName = c.installName ?? info.bundleId;

  const scope = options.scope === "auto" ? (env.isAdmin ? "system" : "user") : options.scope;
  if (scope === "system" && !env.isAdmin) {
    throw new PlanError("installing to the all-users CEP folder needs an elevated (administrator) process");
  }
  const dest = join(scope === "system" ? env.cep.system : env.cep.user, installName);
  const other = join(scope === "system" ? env.cep.user : env.cep.system, installName);

  const destLink = await linkTarget(dest);
  if (destLink && !options.replaceDevLinks) {
    throw new PlanError(
      `${dest} is a developer link to ${destLink}.\n` +
        `  Use --replace-dev-links to replace the link with an installed copy (the linked folder itself is not touched).`,
    );
  }

  const otherLink = await linkTarget(other);
  if (otherLink) {
    result.warnings.push(
      `developer link left in place: ${other} -> ${otherLink}. ` +
        `The app will see two copies of ${info.bundleId} until one is removed.`,
    );
  } else if (await pathExists(other)) {
    result.actions.push({ kind: "removePath", path: other, reason: "same panel in the other CEP folder" });
  }

  for (const app of info.hosts) {
    result.actions.push({ kind: "ensureNotRunning", app, process: APP_PROCESSES[app] });
  }
  if (info.hosts.length > 0 && !env.adobe.some((a) => info.hosts.includes(a.app))) {
    const names = info.hosts.map((h) => APP_LABELS[h]).join(", ");
    result.warnings.push(`${installName}: none of its host apps (${names}) is installed on this machine`);
  }

  result.actions.push({ kind: "replaceDir", from: source, to: dest, exclude: [".debug"] });
  result.items.push({ kind: "path", path: dest });

  if (c.playerDebugMode) {
    if (options.skipRegistry) {
      result.warnings.push("PlayerDebugMode not set (--skip-registry); an unsigned panel only loads if it is already on");
    } else {
      for (const v of CSXS_VERSIONS) {
        result.actions.push({
          kind: "setRegistry",
          key: `HKCU\\Software\\Adobe\\CSXS.${v}`,
          name: "PlayerDebugMode",
          value: "1",
        });
      }
    }
  }
  return result;
}
