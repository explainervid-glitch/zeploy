// Fixtures shared by the tests. Everything is built under the OS temp folder
// (a local disk, where junctions work), never under the real install paths.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { strToU8, zipSync } from "fflate";
import type { Environment } from "../src/index.ts";

export async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "zeploy-test-"));
}

export async function write(path: string, content: string | Uint8Array = ""): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export function fakeEnv(root: string, overrides: Partial<Environment> = {}): Environment {
  const paths = {
    programFiles: join(root, "PF"),
    programFilesX86: join(root, "PF86"),
    commonFiles: join(root, "PF", "Common Files"),
    commonFilesX86: join(root, "PF86", "Common Files"),
    appData: join(root, "Roaming"),
    localAppData: join(root, "Local"),
  };
  return {
    paths,
    isAdmin: false,
    adobe: [
      {
        app: "aftereffects",
        version: "2024",
        dir: join(paths.programFiles, "Adobe", "Adobe After Effects 2024"),
        exe: join(paths.programFiles, "Adobe", "Adobe After Effects 2024", "Support Files", "AfterFX.exe"),
      },
    ],
    blender: [],
    animateConfigs: [],
    upia: null,
    cep: {
      system: join(paths.commonFilesX86, "Adobe", "CEP", "extensions"),
      user: join(paths.appData, "Adobe", "CEP", "extensions"),
    },
    home: join(root, "home"),
    ...overrides,
  };
}

export async function writeCepPanel(dir: string, bundleId: string, hosts: string[] = ["AEFT"]): Promise<void> {
  const hostXml = hosts.map((h) => `<Host Name="${h}" Version="[18.0,99.9]" />`).join("");
  await write(
    join(dir, "CSXS", "manifest.xml"),
    `<?xml version="1.0"?>\n<ExtensionManifest Version="7.0" ExtensionBundleId="${bundleId}" ` +
      `ExtensionBundleVersion="1.0.0"><ExecutionEnvironment><HostList>${hostXml}</HostList>` +
      `</ExecutionEnvironment></ExtensionManifest>`,
  );
  await write(join(dir, "index.html"), "<html></html>");
  await write(join(dir, ".debug"), "<ExtensionList/>");
}

export function blenderExtensionZip(id: string, min = "4.2.0", max?: string): Uint8Array {
  const toml = [
    'schema_version = "1.0.0"',
    `id = "${id}"`,
    'version = "1.0.0"',
    `name = "${id}"`,
    'tagline = "Test extension"',
    'maintainer = "zeploy"',
    'type = "add-on"',
    `blender_version_min = "${min}"`,
    ...(max ? [`blender_version_max = "${max}"`] : []),
    'license = ["SPDX:GPL-3.0-or-later"]',
    "",
    "[permissions]",
    'files = "test"',
  ].join("\n");
  return zipSync({
    "blender_manifest.toml": strToU8(toml),
    "__init__.py": strToU8("def register(): pass\ndef unregister(): pass\n"),
  });
}

export function legacyAddonZip(module: string): Uint8Array {
  return zipSync({
    [`${module}/__init__.py`]: strToU8('bl_info = {"name": "x", "blender": (2, 80, 0)}\n'),
  });
}

export const noProcesses = async () => new Set<string>();

export function collectLog(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line) => lines.push(line) };
}
