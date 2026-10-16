// Signed .zxp/.ccx extensions, installed through Adobe's own
// UnifiedPluginInstallerAgent (part of Creative Cloud).

import { join } from "node:path";
import { emptyResult, PlanError, type Action, type HandlerResult, type PlanContext } from "../actions.ts";
import type { Environment } from "../env.ts";
import type { ZxpComponent } from "../manifest.ts";

function requireUpia(env: Environment): string {
  if (!env.upia) throw new PlanError("UnifiedPluginInstallerAgent.exe not found; is Creative Cloud installed?");
  return env.upia;
}

export async function planZxp(c: ZxpComponent, ctx: PlanContext): Promise<HandlerResult> {
  const upia = requireUpia(ctx.env);
  const result = emptyResult();
  result.actions.push({
    kind: "exec",
    label: `install ${c.extensionName} with UPIA`,
    file: upia,
    args: ["/install", join(ctx.root, c.source)],
  });
  result.items.push({ kind: "zxp", extensionName: c.extensionName });
  result.warnings.push(`restart the host app to load ${c.extensionName}`);
  return result;
}

export function zxpRemoveActions(extensionName: string, env: Environment): Action[] {
  return [
    {
      kind: "exec",
      label: `remove ${extensionName} with UPIA`,
      file: requireUpia(env),
      args: ["/remove", extensionName],
    },
  ];
}
