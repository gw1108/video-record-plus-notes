/**
 * Bridge to the native capture helper (helper/capture-helper, Rust).
 *
 * Two uses:
 * - RawInputHelper (`hotkey` subcommand): listens for the bound inputs during
 *   a session — keyboard via Raw Input RIDEV_INPUTSINK (a parallel delivery
 *   channel that does NOT swallow the key, perf report §5), mouse buttons via
 *   mouse Raw Input, XInput pads via polling, and generic HID
 *   joysticks/gamepads/pedals via HID Raw Input. Prints one JSON line per
 *   press: {"type":"hotkey","label":"mark","wall_ms":1755846000123}
 * - GamepadCaptureHelper (`capture` subcommand): used while the settings UI
 *   has a capture button armed — reports the identity of the next
 *   XInput/HID button press so the saved binding matches exactly what the
 *   runtime listener will see. (Keyboard/mouse capture happens in the
 *   renderer via DOM events instead.)
 *
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
import type { HotkeyBinding, KeyModifiers } from '../common/ipc-contract.js';
import { wallToMonoOffset } from './util.js';

export function findHelperBinary(configuredPath: string): string | null {
  const candidates = [
    configuredPath,
    // Packaged app: electron-builder copies it into resources/ (extraResources).
    join(process.resourcesPath ?? '', 'capture-helper.exe'),
    // Dev checkouts: repo-root/helper/capture-helper/target/{release,debug}
    join(app.getAppPath(), '..', '..', 'helper', 'capture-helper', 'target', 'release', 'capture-helper.exe'),
    join(app.getAppPath(), '..', '..', 'helper', 'capture-helper', 'target', 'debug', 'capture-helper.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/** Modifier chord encoding shared with the helper CLI: 1=ctrl 2=shift 4=alt. */
function modifierBits(m: KeyModifiers): number {
  return (m.ctrl ? 1 : 0) | (m.shift ? 2 : 0) | (m.alt ? 4 : 0);
}

/** CLI args registering one binding with `capture-helper hotkey`. */
export function bindingArgs(label: string, binding: HotkeyBinding): string[] {
  switch (binding.type) {
    case 'keyboard':
      return ['--key', `${binding.vk}:${modifierBits(binding.modifiers)}=${label}`];
    case 'mouse':
      return ['--mouse', `${binding.button}:${modifierBits(binding.modifiers)}=${label}`];
    case 'gamepad':
      return ['--pad', `${binding.code}=${label}`];
    case 'hid':
      return ['--hid', `${binding.vendorId}:${binding.productId}:${binding.buttonIndex}=${label}`];
  }
}

/** Display name for an XInput button code (mask bit, or 0x10000/0x20000 = LT/RT). */
export function padButtonLabel(code: number): string {
  const names: Record<number, string> = {
    0x0001: 'DPad Up',
    0x0002: 'DPad Down',
    0x0004: 'DPad Left',
    0x0008: 'DPad Right',
    0x0010: 'Start',
    0x0020: 'Back',
    0x0040: 'LS',
    0x0080: 'RS',
    0x0100: 'LB',
    0x0200: 'RB',
    0x1000: 'A',
    0x2000: 'B',
    0x4000: 'X',
    0x8000: 'Y',
    0x10000: 'LT',
    0x20000: 'RT',
  };
  return `Pad ${names[code] ?? `0x${code.toString(16)}`}`;
}

export interface HelperHotkeyEvent {
  label: string;
  pressMonoMs: number;
}

function spawnHelper(binaryPath: string, args: string[]): ChildProcessByStdio<null, Readable, Readable> {
  return spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

export class RawInputHelper extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;

  /** @param bindings map of label → binding, e.g. { mark: <F8>, issue: <Mouse 4> } */
  start(binaryPath: string, bindings: Record<string, HotkeyBinding>): void {
    const args = ['hotkey'];
    for (const [label, binding] of Object.entries(bindings)) {
      args.push(...bindingArgs(label, binding));
    }
    this.child = spawnHelper(binaryPath, args);
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

/**
 * Runs `capture-helper capture` while a capture button is armed in the UI and
 * emits 'input' with a ready-to-save HotkeyBinding for each XInput/HID button
 * press. The caller stops it after the first press it accepts.
 */
export class GamepadCaptureHelper extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;

  start(binaryPath: string): void {
    this.child = spawnHelper(binaryPath, ['capture']);
    const rl = createInterface({ input: this.child.stdout });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as {
          type?: string;
          source?: string;
          code?: number;
          vendor?: number;
          product?: number;
          button?: number;
        };
        if (msg.type !== 'capture') return;
        let binding: HotkeyBinding | null = null;
        if (msg.source === 'xinput' && typeof msg.code === 'number') {
          binding = { type: 'gamepad', code: msg.code, label: padButtonLabel(msg.code) };
        } else if (
          msg.source === 'hid' &&
          typeof msg.vendor === 'number' &&
          typeof msg.product === 'number' &&
          typeof msg.button === 'number'
        ) {
          const id = `${msg.vendor.toString(16).padStart(4, '0')}:${msg.product.toString(16).padStart(4, '0')}`;
          binding = {
            type: 'hid',
            vendorId: msg.vendor,
            productId: msg.product,
            buttonIndex: msg.button,
            label: `HID ${id} B${msg.button + 1}`,
          };
        }
        if (binding) this.emit('input', binding);
      } catch {
        // non-JSON noise on stdout; ignore
      }
    });
    this.child.stderr.on('data', (d: Buffer) => this.emit('log', d.toString().trim()));
    this.child.on('exit', () => {
      this.child = null;
    });
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }
}
