/**
 * Bridge to the native capture helper (helper/capture-helper, Rust).
 *
 * Used when hotkeys.mode === 'raw-input': the helper listens for the mark keys
 * via Raw Input RIDEV_INPUTSINK — a parallel delivery channel that does NOT
 * swallow the key (perf report §5) — and prints one JSON line per press:
 *   {"type":"hotkey","label":"mark","vk":119,"wall_ms":1755846000123}
 * The helper stamps wall-clock ms (a clock both processes share); we map it
 * onto this process's monotonic clock at receipt.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { app } from 'electron';
import { wallToMonoOffset } from './util.js';

/** F1–F24 virtual-key codes (0x70 + n-1) — raw-input mode supports F-keys only. */
export function fKeyToVk(accelerator: string): number | null {
  const m = /^F(\d{1,2})$/i.exec(accelerator.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 24) return null;
  return 0x70 + n - 1;
}

export function findHelperBinary(configuredPath: string): string | null {
  const candidates = [
    configuredPath,
    // Dev checkouts: repo-root/helper/capture-helper/target/{release,debug}
    join(app.getAppPath(), '..', '..', 'helper', 'capture-helper', 'target', 'release', 'capture-helper.exe'),
    join(app.getAppPath(), '..', '..', 'helper', 'capture-helper', 'target', 'debug', 'capture-helper.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

export interface HelperHotkeyEvent {
  label: string;
  pressMonoMs: number;
}

export class RawInputHelper extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;

  /** @param keys map of label → accelerator, e.g. { mark: 'F8', issue: 'F9' } */
  start(binaryPath: string, keys: Record<string, string>): void {
    const args = ['hotkey'];
    for (const [label, accel] of Object.entries(keys)) {
      const vk = fKeyToVk(accel);
      if (vk === null) {
        this.emit('error', new Error(`raw-input mode supports F-keys only; got "${accel}" for "${label}"`));
        continue;
      }
      args.push('--vk', `${vk}=${label}`);
    }
    this.child = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const rl = createInterface({ input: this.child.stdout });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as { type?: string; label?: string; wall_ms?: number };
        if (msg.type !== 'hotkey' || !msg.label || typeof msg.wall_ms !== 'number') return;
        const pressMonoMs = msg.wall_ms - wallToMonoOffset();
        this.emit('hotkey', { label: msg.label, pressMonoMs } satisfies HelperHotkeyEvent);
      } catch {
        // non-JSON noise on stdout; ignore
      }
    });
    this.child.stderr.on('data', (d: Buffer) => this.emit('log', d.toString().trim()));
    this.child.on('exit', (code) => {
      this.child = null;
      this.emit('exit', code);
    });
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }
}
