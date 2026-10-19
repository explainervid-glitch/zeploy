// The vocabulary shared by planning and execution.
//
// Installing is split in two: handlers turn a component into a list of plain
// actions (copy this folder there, set this registry value, run this command)
// and the executor carries them out. A dry run prints the list instead, and
// tests check the list without touching the machine.

import type { AppId, Environment } from "./env.ts";
import type { Manifest } from "./manifest.ts";

// `part` names a piece of an install that may fail on its own, such as one
// Blender version ("Blender 4.5"). When an action of a part fails, the rest
// of that part is skipped, the other parts go on, and the receipt leaves the
// part out: the install counts as partly done instead of failed.
export type Action = ActionKind & { part?: string };

type ActionKind =
  | { kind: "ensureNotRunning"; app: AppId; process: string }
  // Copy a folder to `to`, replacing whatever is there. Paths in `exclude`
  // are relative to `from`.
  | { kind: "replaceDir"; from: string; to: string; exclude: string[] }
  | { kind: "copyFile"; from: string; to: string }
  // Remove a file or folder. A symbolic link or junction is removed as a link
  // and never followed.
  | { kind: "removePath"; path: string; reason: string }
  | { kind: "setRegistry"; key: string; name: string; value: string }
  // `tolerate` is a regular expression: a non-zero exit whose output matches
  // it counts as success (e.g. removing something already gone).
  | { kind: "exec"; label: string; file: string; args: string[]; timeoutMs?: number; tolerate?: string };

// What an install left on the machine, kept so it can be removed later.
export type ReceiptItem = ReceiptItemKind & { part?: string };

type ReceiptItemKind =
  | { kind: "path"; path: string }
  | { kind: "blender-extension"; exe: string; version: string; id: string }
  | { kind: "blender-addon"; exe: string; version: string; module: string }
  | { kind: "zxp"; extensionName: string };

export interface Receipt {
  id: string;
  name: string;
  version: string;
  sha256?: string;
  installedAt: string;
  apps: AppId[];
  items: ReceiptItem[];
  // Parts of the install that failed ("Blender 4.5") and why. Absent when
  // everything went on.
  failed?: FailedPart[];
}

export interface FailedPart {
  part: string;
  error: string;
}

export type CepScope = "auto" | "system" | "user";

export interface PlanOptions {
  // Which CEP extensions folder: the all-users one needs administrator rights.
  scope: CepScope;
  // Leave PlayerDebugMode alone.
  skipRegistry: boolean;
  // Replace a developer symlink at the install location with a real copy.
  replaceDevLinks: boolean;
  // Only these Blender versions ("4.2"). Absent means every compatible one.
  blenderVersions?: string[];
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  scope: "auto",
  skipRegistry: false,
  replaceDevLinks: false,
};

export interface PlanContext {
  root: string;
  manifest: Manifest;
  env: Environment;
  options: PlanOptions;
}

export interface HandlerResult {
  actions: Action[];
  items: ReceiptItem[];
  warnings: string[];
}

export interface Plan extends HandlerResult {
  apps: AppId[];
}

// The package cannot go onto this machine as asked. Nothing has been changed
// when this is thrown.
export class PlanError extends Error {
  override name = "PlanError";
}

export function emptyResult(): HandlerResult {
  return { actions: [], items: [], warnings: [] };
}
