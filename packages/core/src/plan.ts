// Turns a package (or a receipt, for removal) into a Plan.

import type { Action, HandlerResult, Plan, PlanContext, Receipt, ReceiptItem } from "./actions.ts";
import { APP_PROCESSES, type AppId, type Environment } from "./env.ts";
import { planAeScript, planAiScript, planJsfl } from "./handlers/adobe-scripts.ts";
import { blenderRemove, planBlender } from "./handlers/blender.ts";
import { planCep } from "./handlers/cep.ts";
import { planZxp, zxpRemoveActions } from "./handlers/zxp.ts";
import type { Component } from "./manifest.ts";

function planComponent(c: Component, ctx: PlanContext): Promise<HandlerResult> {
  switch (c.type) {
    case "cep":
      return planCep(c, ctx);
    case "ae-script":
      return planAeScript(c, ctx);
    case "ai-script":
      return planAiScript(c, ctx);
    case "jsfl":
      return planJsfl(c, ctx);
    case "zxp":
      return planZxp(c, ctx);
    case "blender":
      return planBlender(c, ctx);
  }
}

function itemKey(item: ReceiptItem): string {
  switch (item.kind) {
    case "path":
      return `path:${item.path.toLowerCase()}`;
    case "blender-extension":
      return `bext:${item.exe.toLowerCase()}:${item.id}`;
    case "blender-addon":
      return `badd:${item.exe.toLowerCase()}:${item.module}`;
    case "zxp":
      return `zxp:${item.extensionName}`;
  }
}

async function removeActions(
  item: ReceiptItem,
  env: Environment,
  reason: string,
): Promise<{ actions: Action[]; warnings: string[] }> {
  switch (item.kind) {
    case "path":
      return { actions: [{ kind: "removePath", path: item.path, reason }], warnings: [] };
    case "blender-extension":
    case "blender-addon":
      return blenderRemove(item, env);
    case "zxp":
      return { actions: zxpRemoveActions(item.extensionName, env), warnings: [] };
  }
}

// Running-app checks go first and each appears once; everything else keeps
// the order the handlers gave it.
function finish(actions: Action[], items: ReceiptItem[], warnings: string[]): Plan {
  const apps: AppId[] = [];
  const checks: Action[] = [];
  const rest: Action[] = [];
  const seen = new Set<string>();
  for (const a of actions) {
    if (a.kind === "ensureNotRunning") {
      if (!apps.includes(a.app)) {
        apps.push(a.app);
        checks.push(a);
      }
      continue;
    }
    const key =
      a.kind === "setRegistry"
        ? `reg:${a.key}\\${a.name}`.toLowerCase()
        : a.kind === "removePath"
          ? `rm:${a.path}`.toLowerCase()
          : null;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    rest.push(a);
  }
  return { actions: [...checks, ...rest], items, warnings, apps };
}

// `previous` is the receipt of the version already installed, if any. What it
// installed and the new version no longer does is removed at the end.
export async function planInstall(ctx: PlanContext, previous?: Receipt): Promise<Plan> {
  const actions: Action[] = [];
  const items: ReceiptItem[] = [];
  const warnings: string[] = [];
  for (const c of ctx.manifest.components) {
    const r = await planComponent(c, ctx);
    actions.push(...r.actions);
    items.push(...r.items);
    warnings.push(...r.warnings);
  }

  if (previous) {
    const keep = new Set(items.map(itemKey));
    const stale = previous.items.filter((old) => !keep.has(itemKey(old)));
    for (const old of stale) {
      const r = await removeActions(old, ctx.env, `left over from ${previous.version}`);
      actions.push(...r.actions);
      warnings.push(...r.warnings);
    }
    if (stale.length > 0) {
      for (const app of previous.apps) {
        actions.push({ kind: "ensureNotRunning", app, process: APP_PROCESSES[app] });
      }
    }
  }
  return finish(actions, items, warnings);
}

export async function planUninstall(receipt: Receipt, env: Environment): Promise<Plan> {
  const actions: Action[] = receipt.apps.map((app) => ({
    kind: "ensureNotRunning" as const,
    app,
    process: APP_PROCESSES[app],
  }));
  const warnings: string[] = [];
  for (const item of receipt.items) {
    const r = await removeActions(item, env, `uninstall ${receipt.id}`);
    actions.push(...r.actions);
    warnings.push(...r.warnings);
  }
  return finish(actions, [], warnings);
}
