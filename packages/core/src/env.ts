// What is installed on this machine and where things go.
//
// detectEnvironment() looks at the real machine. Every path it uses comes from
// WindowsPaths, so tests can point it at a fake folder tree instead.

import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { migrateLegacyDir } from "./fsutil.ts";
import { isElevated } from "./win.ts";

export interface WindowsPaths {
  programFiles: string;
  programFilesX86: string;
  commonFiles: string;
  commonFilesX86: string;
  appData: string;
  localAppData: string;
}

export type AdobeAppId = "aftereffects" | "premiere" | "animate" | "illustrator";
export type AppId = AdobeAppId | "blender";

export interface AdobeInstall {
  app: AdobeAppId;
  // Folder name without the product prefix: "2024", "2026", "(Beta)".
  version: string;
  dir: string;
  exe: string;
}

export interface BlenderInstall {
  // Major.minor, taken from the version folder beside blender.exe: "4.2".
  version: string;
  dir: string;
  exe: string;
}

export interface AnimateConfig {
  version: string;
  lang: string;
  // ...\Adobe\Animate 2024\en_US\Configuration
  dir: string;
}

export interface Environment {
  paths: WindowsPaths;
  isAdmin: boolean;
  adobe: AdobeInstall[];
  blender: BlenderInstall[];
  animateConfigs: AnimateConfig[];
  // Adobe's UnifiedPluginInstallerAgent.exe, when Creative Cloud is installed.
  upia: string | null;
  cep: { system: string; user: string };
  // zeploy's own state: receipts and staging.
  home: string;
}

export const APP_LABELS: Record<AppId, string> = {
  aftereffects: "After Effects",
  premiere: "Premiere Pro",
  animate: "Animate",
  illustrator: "Illustrator",
  blender: "Blender",
};

export const APP_PROCESSES: Record<AppId, string> = {
  aftereffects: "AfterFX.exe",
  premiere: "Adobe Premiere Pro.exe",
  animate: "Animate.exe",
  illustrator: "Illustrator.exe",
  blender: "blender.exe",
};

// Host codes used in CSXS/manifest.xml, mapped to the process that loads the
// panel. Only the hosts zeploy targets are named; others are ignored.
export const CEP_HOSTS: Record<string, AdobeAppId> = {
  AEFT: "aftereffects",
  PPRO: "premiere",
  FLPR: "animate",
  ILST: "illustrator",
};

const ADOBE_PRODUCTS: { app: AdobeAppId; prefix: string; exe: string[] }[] = [
  { app: "aftereffects", prefix: "Adobe After Effects ", exe: ["Support Files", "AfterFX.exe"] },
  { app: "premiere", prefix: "Adobe Premiere Pro ", exe: ["Adobe Premiere Pro.exe"] },
  { app: "animate", prefix: "Adobe Animate ", exe: ["Animate.exe"] },
  { app: "illustrator", prefix: "Adobe Illustrator ", exe: ["Support Files", "Contents", "Windows", "Illustrator.exe"] },
];

export function defaultPaths(env: NodeJS.ProcessEnv = process.env): WindowsPaths {
  const programFiles = env["ProgramW6432"] ?? env["ProgramFiles"] ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const home = env["USERPROFILE"] ?? "C:\\Users\\Default";
  return {
    programFiles,
    programFilesX86,
    commonFiles: env["CommonProgramW6432"] ?? join(programFiles, "Common Files"),
    commonFilesX86: env["CommonProgramFiles(x86)"] ?? join(programFilesX86, "Common Files"),
    appData: env["APPDATA"] ?? join(home, "AppData", "Roaming"),
    localAppData: env["LOCALAPPDATA"] ?? join(home, "AppData", "Local"),
  };
}

export interface DetectOptions {
  paths?: Partial<WindowsPaths>;
  isAdmin?: boolean;
  // Extra blender.exe paths. Also read from ZEPLOY_BLENDER, separated by ";".
  blenderExes?: string[];
  home?: string;
}

export async function detectEnvironment(options: DetectOptions = {}): Promise<Environment> {
  const paths = { ...defaultPaths(), ...options.paths };
  const extraBlender = [
    ...(options.blenderExes ?? []),
    ...(process.env["ZEPLOY_BLENDER"] ?? "").split(";").filter(Boolean),
  ];

  const [isAdmin, adobe, blender, animateConfigs, upia] = await Promise.all([
    options.isAdmin ?? isElevated(),
    findAdobeInstalls(paths),
    findBlenderInstalls(paths, extraBlender),
    findAnimateConfigs(paths),
    findUpia(paths),
  ]);

  let home = options.home ?? process.env["ZEPLOY_HOME"];
  if (!home) {
    home = join(paths.localAppData, "zeploy");
    migrateLegacyDir(join(paths.localAppData, "zdeploy"), home);
  }

  return {
    paths,
    isAdmin,
    adobe,
    blender,
    animateConfigs,
    upia,
    cep: {
      system: join(paths.commonFilesX86, "Adobe", "CEP", "extensions"),
      user: join(paths.appData, "Adobe", "CEP", "extensions"),
    },
    home,
  };
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

async function subdirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function findAdobeInstalls(paths: WindowsPaths): Promise<AdobeInstall[]> {
  const root = join(paths.programFiles, "Adobe");
  const found: AdobeInstall[] = [];
  for (const name of await subdirs(root)) {
    const product = ADOBE_PRODUCTS.find((p) => name.startsWith(p.prefix));
    if (!product) continue;
    const dir = join(root, name);
    const exe = join(dir, ...product.exe);
    if (await exists(exe)) {
      found.push({ app: product.app, version: name.slice(product.prefix.length).trim(), dir, exe });
    }
  }
  return found.sort((a, b) => a.app.localeCompare(b.app) || a.version.localeCompare(b.version));
}

// Blender keeps its bundled scripts in a folder named after its version
// ("4.2") beside blender.exe, which is the reliable way to tell versions apart.
async function blenderAt(exe: string): Promise<BlenderInstall | null> {
  if (!(await exists(exe))) return null;
  const dir = dirname(exe);
  const versions = (await subdirs(dir)).filter((n) => /^\d+\.\d+$/.test(n)).sort(compareVersions);
  const version = versions.at(-1);
  return version ? { version, dir, exe } : null;
}

async function findBlenderInstalls(paths: WindowsPaths, extra: string[]): Promise<BlenderInstall[]> {
  const candidates: string[] = [];
  const foundation = join(paths.programFiles, "Blender Foundation");
  for (const name of await subdirs(foundation)) candidates.push(join(foundation, name, "blender.exe"));
  candidates.push(join(paths.programFilesX86, "Steam", "steamapps", "common", "Blender", "blender.exe"));
  candidates.push(...extra);

  const seen = new Set<string>();
  const found: BlenderInstall[] = [];
  for (const exe of candidates) {
    const key = exe.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const install = await blenderAt(exe);
    if (install) found.push(install);
  }
  return found.sort((a, b) => compareVersions(a.version, b.version));
}

async function findAnimateConfigs(paths: WindowsPaths): Promise<AnimateConfig[]> {
  const root = join(paths.localAppData, "Adobe");
  const found: AnimateConfig[] = [];
  for (const name of await subdirs(root)) {
    if (!name.startsWith("Animate ")) continue;
    for (const lang of await subdirs(join(root, name))) {
      const dir = join(root, name, lang, "Configuration");
      if (await exists(dir)) found.push({ version: name.slice("Animate ".length).trim(), lang, dir });
    }
  }
  return found;
}

async function findUpia(paths: WindowsPaths): Promise<string | null> {
  const exe = join(
    paths.commonFiles,
    "Adobe",
    "Adobe Desktop Common",
    "RemoteComponents",
    "UPI",
    "UnifiedPluginInstallerAgent",
    "UnifiedPluginInstallerAgent.exe",
  );
  return (await exists(exe)) ? exe : null;
}

// Numeric compare of dotted versions: "4.10" > "4.2", "4.2" == "4.2.0".
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
