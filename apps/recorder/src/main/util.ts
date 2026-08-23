import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Monotonic milliseconds since process start (QPC-backed on Windows). */
export function monoMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

/**
 * Offset such that `wallMs - wallToMonoOffset() ≈ monoMs()` right now.
 * Used to map wall-clock stamps from the native helper (a separate process
 * with its own monotonic epoch) onto this process's monotonic clock.
 */
export function wallToMonoOffset(): number {
  return Date.now() - monoMs();
}

/**
 * Directory-safe session id: "2026-08-22_153042_my-title". Second resolution:
 * a start→stop→restart "false start" with the same title must never map two
 * sessions onto one directory (the journal opens with flag 'a' and would
 * merge them).
 */
export function makeSessionId(title: string, when = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}_${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'session';
  return `${stamp}_${slug}`;
}

/**
 * makeSessionId plus a directory-collision probe: if `sessionsDir/<id>`
 * already exists (two sessions within the same second, or a clock rollback),
 * suffix "-2", "-3", … so a new session never appends into an earlier
 * session's journal.
 */
export function uniqueSessionId(sessionsDir: string, title: string, when = new Date()): string {
  const base = makeSessionId(title, when);
  let id = base;
  for (let n = 2; existsSync(join(sessionsDir, id)); n += 1) id = `${base}-${n}`;
  return id;
}
