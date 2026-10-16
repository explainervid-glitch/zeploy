// The package manifest: zeploy.json at the root of every plugin package.
//
// A package is a folder (or a zip of that folder) holding zeploy.json plus
// the files its components point at. Each component says what kind of thing
// it is and the engine works out where it goes on the machine, so a plugin
// never needs its own install script.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const MANIFEST_FILE = "zeploy.json";

// A path inside the package. Absolute paths, drive letters and ".." segments
// are refused so a manifest can never point the installer outside its own
// package folder.
export function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || p.includes("\0")) return false;
  const norm = p.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) return false;
  return !norm.split("/").some((seg) => seg === "..");
}

const relPath = z
  .string()
  .min(1)
  .refine(isSafeRelativePath, { message: "must be a relative path inside the package" });

const versionString = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, { message: "must look like 1.2.3" });

// Year labels of Adobe installs ("2024", "2026"), matched against the folder
// name of each detected install. Empty or absent means every detected one.
const adobeVersions = z.array(z.string().min(1)).optional();

const cepComponent = z.object({
  type: z.literal("cep"),
  // Folder holding CSXS/manifest.xml.
  source: relPath,
  // Folder name under CEP/extensions. Defaults to ExtensionBundleId from
  // CSXS/manifest.xml. Set it when an existing install uses another name
  // (AudiMate installs as "AudiMate", not as its bundle id).
  installName: z
    .string()
    .regex(/^[A-Za-z0-9._ -]+$/)
    .optional(),
  // Unsigned extensions only load with PlayerDebugMode=1.
  playerDebugMode: z.boolean().default(true),
});

const aeScriptComponent = z.object({
  type: z.literal("ae-script"),
  // A .jsx/.jsxbin file or a folder, copied as is.
  source: relPath,
  folder: z.enum(["ScriptUI Panels", "Scripts", "Startup", "Shutdown"]).default("ScriptUI Panels"),
  versions: adobeVersions,
});

const jsflComponent = z.object({
  type: z.literal("jsfl"),
  // A .jsfl file or a folder, copied into Animate's per-user Configuration.
  source: relPath,
  folder: z.enum(["Commands", "Tools", "WindowSWF", "Javascript"]).default("Commands"),
  versions: adobeVersions,
});

const zxpComponent = z.object({
  type: z.literal("zxp"),
  // A signed .zxp or .ccx, installed through Adobe's UnifiedPluginInstallerAgent.
  source: relPath,
  // The name UPIA lists the extension under, needed to remove it again.
  extensionName: z.string().min(1),
});

const blenderComponent = z.object({
  type: z.literal("blender"),
  // A Blender extension .zip (with blender_manifest.toml), a legacy add-on
  // .zip (one top-level folder with __init__.py) or a single-file .py add-on.
  source: relPath.refine((p) => /\.(zip|py)$/i.test(p), { message: "must be a .zip or .py file" }),
  // Read from the archive when absent.
  kind: z.enum(["extension", "addon"]).optional(),
  // Extension id or add-on module name. Read from the archive when absent.
  // Legacy add-on folders are often not Python identifiers
  // ("auto_rig_pro-master"), and Blender accepts them anyway.
  module: z
    .string()
    .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/)
    .optional(),
  // Blender versions ("4.2") this may go into. minBlender defaults to the
  // extension's blender_version_min.
  minBlender: z
    .string()
    .regex(/^\d+\.\d+(\.\d+)?$/)
    .optional(),
  maxBlender: z
    .string()
    .regex(/^\d+\.\d+(\.\d+)?$/)
    .optional(),
});

export const componentSchema = z.discriminatedUnion("type", [
  cepComponent,
  aeScriptComponent,
  jsflComponent,
  zxpComponent,
  blenderComponent,
]);

export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, {
    message: "lowercase letters, digits, '.', '_' and '-' only",
  }),
  name: z.string().min(1),
  version: versionString,
  description: z.string().optional(),
  components: z.array(componentSchema).min(1),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type Component = z.infer<typeof componentSchema>;
export type CepComponent = z.infer<typeof cepComponent>;
export type AeScriptComponent = z.infer<typeof aeScriptComponent>;
export type JsflComponent = z.infer<typeof jsflComponent>;
export type ZxpComponent = z.infer<typeof zxpComponent>;
export type BlenderComponent = z.infer<typeof blenderComponent>;

export class ManifestError extends Error {
  override name = "ManifestError";
}

export function parseManifest(data: unknown, origin = MANIFEST_FILE): Manifest {
  const result = manifestSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ManifestError(`${origin} is not valid:\n${issues}`);
  }
  return result.data;
}

export async function readManifest(packageRoot: string): Promise<Manifest> {
  const file = join(packageRoot, MANIFEST_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new ManifestError(`${MANIFEST_FILE} not found in ${packageRoot}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch (err) {
    throw new ManifestError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  return parseManifest(data, file);
}
