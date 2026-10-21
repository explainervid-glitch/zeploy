// Saving the admin's JSON files (state.json, usage.json) so that a failed
// write never stops later ones.
//
// Each write goes to <file>.tmp and is renamed over the file, so the file is
// always whole. On Windows the rename fails now and then while another
// program (antivirus, the search indexer, a backup tool) has the file open;
// it is retried for a moment, and failing that the next write is attempted
// again a few seconds later. Every failure is logged, and so is the first
// write that works again.

import { copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);

async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!BUSY.has(code)) throw err;
      if (attempt < 8) {
        await sleep(100 * (attempt + 1));
        continue;
      }
      // Some locks allow writing the file but not replacing it.
      await copyFile(from, to);
      await rm(from, { force: true });
      return;
    }
  }
}

export interface JsonFileOptions {
  log?: (line: string) => void;
  // Wait before writing again after a failure. Tests shorten it.
  retryMs?: number;
}

export class JsonFile {
  readonly path: string;
  readonly #log: (line: string) => void;
  readonly #retryMs: number;
  #writing: Promise<void> = Promise.resolve();
  #retry: NodeJS.Timeout | null = null;
  #failed = false;
  #render: (() => string) | null = null;

  constructor(path: string, options: JsonFileOptions = {}) {
    this.path = path;
    this.#log = options.log ?? ((line) => console.error(line));
    this.#retryMs = options.retryMs ?? 5000;
  }

  // Null when the file does not exist yet. Any other problem (locked,
  // unreadable, not JSON) throws: starting over would overwrite real data.
  async read<T>(): Promise<T | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`cannot read ${this.path}: ${(err as Error).message}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new Error(`${this.path} is damaged (${(err as Error).message}); restore it from a copy, or move it away to start empty`);
    }
  }

  // Writes what `render` returns at the time of writing, so a retry saves the
  // latest data. Rejects when this write failed (it is logged either way);
  // later writes go ahead regardless.
  write(render: () => string): Promise<void> {
    this.#render = render;
    const run = this.#writing.then(async () => {
      if (this.#retry) {
        clearTimeout(this.#retry);
        this.#retry = null;
      }
      try {
        await writeFile(`${this.path}.tmp`, render());
        await renameOver(`${this.path}.tmp`, this.path);
      } catch (err) {
        this.#log(`could not save ${this.path}: ${(err as Error).message}; trying again in ${this.#retryMs / 1000} s`);
        this.#failed = true;
        this.#retry = setTimeout(() => {
          this.#retry = null;
          if (this.#render) this.write(this.#render).catch(() => {});
        }, this.#retryMs);
        this.#retry.unref();
        throw err;
      }
      if (this.#failed) {
        this.#failed = false;
        this.#log(`saved ${this.path} again`);
      }
    });
    this.#writing = run.catch(() => {});
    return run;
  }

  // No more retries, as when the server closes.
  stop(): void {
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    this.#render = null;
  }
}
