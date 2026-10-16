// The top-level operations: install a package, uninstall by id.

import { join } from "node:path";
import { DEFAULT_PLAN_OPTIONS, PlanError, type Plan, type PlanOptions, type Receipt } from "./actions.ts";
import type { Environment } from "./env.ts";
import { executePlan, type ExecuteOptions } from "./executor.ts";
import type { Manifest } from "./manifest.ts";
import { openPackage } from "./package.ts";
import { planInstall, planUninstall } from "./plan.ts";
import { deleteReceipt, readReceipt, writeReceipt } from "./receipts.ts";

export interface InstallOptions extends ExecuteOptions {
  plan?: Partial<PlanOptions>;
  expectedSha256?: string;
}

export interface InstallResult {
  manifest: Manifest;
  plan: Plan;
  previous: Receipt | null;
  receipt: Receipt | null;
}

export async function installPackage(
  path: string,
  env: Environment,
  options: InstallOptions,
): Promise<InstallResult> {
  const pkg = await openPackage(path, {
    stagingRoot: join(env.home, "staging"),
    expectedSha256: options.expectedSha256,
  });
  try {
    const { manifest } = pkg;
    const previous = await readReceipt(env, manifest.id);
    const plan = await planInstall(
      { root: pkg.root, manifest, env, options: { ...DEFAULT_PLAN_OPTIONS, ...options.plan } },
      previous ?? undefined,
    );
    await executePlan(plan, options);
    if (options.dryRun) return { manifest, plan, previous, receipt: null };

    const receipt: Receipt = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      sha256: pkg.archive?.sha256,
      installedAt: new Date().toISOString(),
      apps: plan.apps,
      items: plan.items,
    };
    await writeReceipt(env, receipt);
    return { manifest, plan, previous, receipt };
  } finally {
    await pkg.close();
  }
}

export async function uninstallPackage(id: string, env: Environment, options: ExecuteOptions): Promise<Receipt> {
  const receipt = await readReceipt(env, id);
  if (!receipt) throw new PlanError(`${id} is not installed (no receipt in ${join(env.home, "receipts")})`);
  await executePlan(await planUninstall(receipt, env), options);
  if (!options.dryRun) await deleteReceipt(env, id);
  return receipt;
}
