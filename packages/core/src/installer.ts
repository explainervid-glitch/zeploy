// The top-level operations: install a package, uninstall by id.

import { join } from "node:path";
import {
  DEFAULT_PLAN_OPTIONS,
  PlanError,
  type FailedPart,
  type Plan,
  type PlanOptions,
  type Receipt,
  type ReceiptItem,
} from "./actions.ts";
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
  // Parts that failed while the rest installed; empty when all went on.
  failed: FailedPart[];
}

export class InstallError extends Error {
  override name = "InstallError";
}

const sameItem = (a: ReceiptItem, b: ReceiptItem) => JSON.stringify({ ...a, part: undefined }) === JSON.stringify({ ...b, part: undefined });

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
    const failed = await executePlan(plan, options);
    if (options.dryRun) return { manifest, plan, previous, receipt: null, failed };

    const isFailed = (item: ReceiptItem) => !!item.part && failed.some((f) => f.part === item.part);
    if (failed.length && plan.items.every(isFailed)) {
      throw new InstallError(failed.map((f) => `${f.part}: ${f.error}`).join("\n"));
    }
    // A part that failed keeps what the previous version put there, so it
    // can still be removed later; the parts that worked have the new items.
    const kept = (previous?.items ?? []).filter((old) => plan.items.some((item) => isFailed(item) && sameItem(item, old)));

    const receipt: Receipt = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      sha256: pkg.archive?.sha256,
      installedAt: new Date().toISOString(),
      apps: plan.apps,
      items: [...plan.items.filter((item) => !isFailed(item)), ...kept],
      ...(failed.length ? { failed } : {}),
    };
    await writeReceipt(env, receipt);
    return { manifest, plan, previous, receipt, failed };
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
