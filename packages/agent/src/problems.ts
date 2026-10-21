// What went wrong in the agent lately, for the admin to see: an error the
// agent caught and carried on after, such as apps that could not be
// detected. Kept for a day, newest first; the same message again only
// moves its time, and does not count as a change (reporting a change
// can run into the same problem again).

import type { Problem } from "../../protocol/src/index.ts";

export interface Problems {
  record(message: string): void;
  recent(): Problem[];
}

const KEEP_MS = 24 * 60 * 60 * 1000;
const MAX = 10;

export function createProblems(onChange?: () => void, now: () => number = Date.now): Problems {
  let list: { at: number; message: string }[] = [];
  return {
    record(message) {
      const text = message.trim().slice(0, 500);
      const known = list.some((p) => p.message === text);
      list = [{ at: now(), message: text }, ...list.filter((p) => p.message !== text)].slice(0, MAX);
      if (!known) onChange?.();
    },
    recent() {
      list = list.filter((p) => now() - p.at < KEEP_MS);
      return list.map((p) => ({ at: new Date(p.at).toISOString(), message: p.message }));
    },
  };
}
