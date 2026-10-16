#!/usr/bin/env node
// zdeploy: install, remove and inspect plugin packages on this machine.
// Phase 1 front end for the core engine; the LAN agent will call the same
// engine directly.

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  APP_LABELS,
  AppRunningError,
  detectEnvironment,
  ExecError,
  inspectBlenderSource,
  installPackage,
  listReceipts,
  ManifestError,
  openPackage,
  PackageError,
  packPackage,
  PlanError,
  readCepManifest,
  uninstallPackage,
  type CepScope,
  type Environment,
  type IfRunning,
} from "../../core/src/index.ts";

const USAGE = `zdeploy - plugin installer for After Effects, Premiere Pro, Animate and Blender

Usage:
  zdeploy detect [--json]                 Show installed apps and install locations
  zdeploy validate <package>              Check a package folder or .zip
  zdeploy pack <folder> [--out <dir>]     Build <id>-<version>.zip from a package folder
  zdeploy install <package> [options]     Install a package folder or .zip
  zdeploy uninstall <id> [options]        Remove an installed package
  zdeploy list                            Show packages installed by zdeploy

Install / uninstall options:
  --dry-run                    Print what would happen, change nothing
  --if-running fail|kill|ignore
                               When a target app is open (default: fail)
  --scope auto|user|system     CEP extensions folder (default: auto = system when elevated)
  --skip-registry              Do not set PlayerDebugMode
  --replace-dev-links          Replace a developer symlink at the install location
  --blender <versions>         Only these Blender versions, e.g. 4.2,5.1
  --sha256 <hex>               Refuse a .zip whose SHA-256 differs
`;

class UsageError extends Error {}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string, fallback: T): T {
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new UsageError(`${flag} must be one of: ${allowed.join(", ")}`);
}

function log(line: string): void {
  console.log(line);
}

// "2026-10-16 08:48" in this machine's time zone.
function localTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function printEnvironment(env: Environment): void {
  log(`Elevated (administrator): ${env.isAdmin ? "yes" : "no"}`);
  log("");
  log("Adobe apps:");
  if (env.adobe.length === 0) log("  (none found)");
  for (const a of env.adobe) log(`  ${APP_LABELS[a.app].padEnd(14)} ${a.version.padEnd(8)} ${a.dir}`);
  log("");
  log("Blender:");
  if (env.blender.length === 0) log("  (none found)");
  for (const b of env.blender) log(`  ${b.version.padEnd(8)} ${b.exe}`);
  log("");
  log("Animate Configuration folders:");
  if (env.animateConfigs.length === 0) log("  (none found)");
  for (const c of env.animateConfigs) log(`  ${c.version} ${c.lang.padEnd(6)} ${c.dir}`);
  log("");
  log("CEP extensions:");
  log(`  all users  ${env.cep.system}`);
  log(`  this user  ${env.cep.user}`);
  log(`UPIA:         ${env.upia ?? "(not found)"}`);
  log(`zdeploy home: ${env.home}`);
}

async function cmdValidate(path: string, env: Environment): Promise<void> {
  const pkg = await openPackage(resolve(path), { stagingRoot: join(env.home, "staging") });
  try {
    const m = pkg.manifest;
    log(`OK  ${m.name} (${m.id}) ${m.version}`);
    if (pkg.archive) log(`    sha256 ${pkg.archive.sha256}`);
    for (const c of m.components) {
      const full = join(pkg.root, c.source);
      if (c.type === "cep") {
        const info = await readCepManifest(full);
        const hosts = info.hosts.map((h) => APP_LABELS[h]).join(", ") || "no known host";
        log(`    cep        ${c.source}  bundle ${info.bundleId} ${info.version ?? ""}  [${hosts}]`);
      } else if (c.type === "blender") {
        const info = await inspectBlenderSource(full);
        const range = info.minBlender ? `Blender ${info.minBlender}+` : "any Blender";
        log(`    blender    ${c.source}  ${c.kind ?? info.kind} ${c.module ?? info.module}  (${range})`);
      } else {
        log(`    ${c.type.padEnd(10)} ${c.source}`);
      }
    }
  } finally {
    await pkg.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      out: { type: "string" },
      "dry-run": { type: "boolean" },
      "if-running": { type: "string" },
      scope: { type: "string" },
      "skip-registry": { type: "boolean" },
      "replace-dev-links": { type: "boolean" },
      blender: { type: "string" },
      sha256: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  const [command, arg] = positionals;
  if (!command || values.help) {
    log(USAGE);
    return values.help ? 0 : 2;
  }

  const needArg = (what: string) => {
    if (!arg) throw new UsageError(`${command} needs ${what}`);
    return arg;
  };

  const env = await detectEnvironment();
  const dryRun = values["dry-run"] ?? false;
  const exec = {
    dryRun,
    ifRunning: oneOf<IfRunning>(values["if-running"], ["fail", "kill", "ignore"], "--if-running", "fail"),
    log,
  };

  switch (command) {
    case "detect":
      if (values.json) log(JSON.stringify(env, null, 2));
      else printEnvironment(env);
      return 0;

    case "validate":
      await cmdValidate(needArg("a package path"), env);
      return 0;

    case "pack": {
      const folder = resolve(needArg("a package folder"));
      const r = await packPackage(folder, resolve(values.out ?? join(folder, "dist")));
      log(`Packed ${r.manifest.id} ${r.manifest.version}: ${r.fileCount} files, ${(r.size / 1024).toFixed(1)} KB`);
      log(`  ${r.path}`);
      log(`  sha256 ${r.sha256}`);
      return 0;
    }

    case "install": {
      const path = resolve(needArg("a package path"));
      const blenderVersions = values.blender?.split(",").map((v) => v.trim()).filter(Boolean);
      log(`${dryRun ? "Dry run: " : ""}installing ${path}`);
      const r = await installPackage(path, env, {
        ...exec,
        expectedSha256: values.sha256,
        plan: {
          scope: oneOf<CepScope>(values.scope, ["auto", "user", "system"], "--scope", "auto"),
          skipRegistry: values["skip-registry"] ?? false,
          replaceDevLinks: values["replace-dev-links"] ?? false,
          blenderVersions,
        },
      });
      const from = r.previous ? ` (was ${r.previous.version})` : "";
      log(dryRun ? "Dry run done, nothing changed." : `Installed ${r.manifest.name} ${r.manifest.version}${from}.`);
      return 0;
    }

    case "uninstall": {
      const id = needArg("a package id");
      log(`${dryRun ? "Dry run: " : ""}removing ${id}`);
      const receipt = await uninstallPackage(id, env, exec);
      log(dryRun ? "Dry run done, nothing changed." : `Removed ${receipt.name} ${receipt.version}.`);
      return 0;
    }

    case "list": {
      const receipts = await listReceipts(env);
      if (receipts.length === 0) log("No packages installed by zdeploy.");
      for (const r of receipts) {
        const apps = r.apps.map((a) => APP_LABELS[a]).join(", ");
        log(`${r.id.padEnd(24)} ${r.version.padEnd(10)} ${localTime(r.installedAt)}  ${apps}`);
      }
      return 0;
    }

    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

const KNOWN_ERRORS = [ManifestError, PackageError, PlanError, AppRunningError, ExecError];

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof UsageError || (err instanceof TypeError && "code" in err && String(err.code).startsWith("ERR_PARSE_ARGS"))) {
      console.error(`error: ${(err as Error).message}\n`);
      console.error(USAGE);
      process.exit(2);
    }
    if (KNOWN_ERRORS.some((E) => err instanceof E)) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  },
);
