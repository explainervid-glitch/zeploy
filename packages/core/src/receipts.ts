// Receipts: one JSON file per installed package under <home>\receipts,
// recording what the install put on the machine so it can be taken off again.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Receipt } from "./actions.ts";
import type { Environment } from "./env.ts";

function receiptDir(env: Environment): string {
  return join(env.home, "receipts");
}

function receiptPath(env: Environment, id: string): string {
  return join(receiptDir(env), `${id}.json`);
}

export async function readReceipt(env: Environment, id: string): Promise<Receipt | null> {
  try {
    return JSON.parse(await readFile(receiptPath(env, id), "utf8")) as Receipt;
  } catch {
    return null;
  }
}

export async function writeReceipt(env: Environment, receipt: Receipt): Promise<void> {
  await mkdir(receiptDir(env), { recursive: true });
  await writeFile(receiptPath(env, receipt.id), JSON.stringify(receipt, null, 2) + "\n");
}

export async function deleteReceipt(env: Environment, id: string): Promise<void> {
  await rm(receiptPath(env, id), { force: true });
}

export async function listReceipts(env: Environment): Promise<Receipt[]> {
  let names: string[];
  try {
    names = await readdir(receiptDir(env));
  } catch {
    return [];
  }
  const out: Receipt[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const r = await readReceipt(env, name.slice(0, -".json".length));
    if (r) out.push(r);
  }
  return out;
}
