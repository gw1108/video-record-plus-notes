import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HotkeyBinding, PipelineConfig, RecorderConfig } from '../common/ipc-contract.js';

/**
 * On-disk shape of the obs section: the password is stored encrypted via
 * Electron safeStorage (DPAPI on Windows). Plain `password` is read for
 * configs written before encryption existed, and written only when the OS
 * keystore is unavailable.
 */
interface StoredObsConfig {
  host?: string;
  port?: number;
  password?: string;
  passwordEncrypted?: string; // base64 safeStorage ciphertext
}

/** F-key binding with no modifiers — the shape of the F8/F9 defaults. */
export function fKeyBinding(n: number): HotkeyBinding {
  return {
    type: 'keyboard',
    vk: 0x70 + n - 1,
    modifiers: { ctrl: false, shift: false, alt: false },
    accelerator: `F${n}`,
    label: `F${n}`,
  };
}

/**
 * Configs written before capture buttons stored bindings as Electron
 * accelerator strings ("F8", "Ctrl+Shift+B"). Convert what we can; anything
 * unparseable falls back to the default binding.
 */
function migrateBinding(value: unknown, fallback: HotkeyBinding): HotkeyBinding {
  if (value && typeof value === 'object' && 'type' in value) return value as HotkeyBinding;
  if (typeof value !== 'string') return fallback;
  const parts = value.split('+').map((p) => p.trim()).filter(Boolean);
  const modifiers = { ctrl: false, shift: false, alt: false };
  let key: string | null = null;
  for (const part of parts) {
    const p = part.toLowerCase();
    if (p === 'ctrl' || p === 'control' || p === 'commandorcontrol' || p === 'cmdorctrl') modifiers.ctrl = true;
    else if (p === 'shift') modifiers.shift = true;
    else if (p === 'alt') modifiers.alt = true;
    else key = part;
  }
  if (!key) return fallback;
  let vk: number | null = null;
  const fMatch = /^F(\d{1,2})$/i.exec(key);
  if (fMatch && Number(fMatch[1]) >= 1 && Number(fMatch[1]) <= 24) vk = 0x70 + Number(fMatch[1]) - 1;
  else if (/^[A-Z0-9]$/i.test(key)) vk = key.toUpperCase().charCodeAt(0); // VK_A..VK_Z / VK_0..VK_9 match ASCII
  if (vk === null) return fallback;
  const mods = [modifiers.ctrl && 'Ctrl', modifiers.shift && 'Shift', modifiers.alt && 'Alt'].filter(Boolean);
  const label = [...mods, key.toUpperCase()].join('+');
  return { type: 'keyboard', vk, modifiers, accelerator: label, label };
}

/** Pipeline defaults mirror pipeline/playtest_pipeline/plan.py + cli.py. */
export const DEFAULT_PIPELINE: PipelineConfig = {
  autoRun: false,
  command: 'playtest-pipeline',
  model: 'small',
  preSeconds: 20,
  postSeconds: 10,
  mergeGapSeconds: 1,
};

export function defaultConfig(): RecorderConfig {
  return {
    obs: { host: '127.0.0.1', port: 4455, password: '' },
    hotkeys: {
      mark: fKeyBinding(8),
      issue: fKeyBinding(9),
      labels: { mark: 'mark', issue: 'issue' },
      mode: 'global-shortcut',
    },
    telemetry: {
      enabled: false,
      url: 'http://127.0.0.1:46333/playtest/time',
      pollIntervalMs: 500,
    },
    pipeline: { ...DEFAULT_PIPELINE },
    sessionsDir: join(app.getPath('videos'), 'PlaytestSessions'),
    helperPath: '',
    setupDone: false,
  };
}

/** Directory-safe, non-empty label; falls back to the slot's default. */
function cleanLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().slice(0, 32);
  return trimmed || fallback;
}

function finiteOr(value: unknown, fallback: number, min = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** Clamp/validate the pipeline section — bad values would break the command line. */
export function normalizePipeline(raw: Partial<PipelineConfig> | undefined): PipelineConfig {
  const d = DEFAULT_PIPELINE;
  return {
    autoRun: raw?.autoRun === true,
    command: (typeof raw?.command === 'string' && raw.command.trim()) || d.command,
    model: (typeof raw?.model === 'string' && raw.model.trim()) || d.model,
    preSeconds: finiteOr(raw?.preSeconds, d.preSeconds),
    postSeconds: finiteOr(raw?.postSeconds, d.postSeconds),
    mergeGapSeconds: finiteOr(raw?.mergeGapSeconds, d.mergeGapSeconds),
  };
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

function decryptPassword(obs: StoredObsConfig | undefined): string {
  if (!obs) return '';
  if (obs.passwordEncrypted) {
    try {
      return safeStorage.decryptString(Buffer.from(obs.passwordEncrypted, 'base64'));
    } catch {
      return ''; // config copied from another machine/user account
    }
  }
  return obs.password ?? '';
}

export function loadConfig(): RecorderConfig {
  const defaults = defaultConfig();
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<
      Omit<RecorderConfig, 'obs'>
    > & { obs?: StoredObsConfig };
    return {
      obs: {
        host: raw.obs?.host ?? defaults.obs.host,
        port: raw.obs?.port ?? defaults.obs.port,
        password: decryptPassword(raw.obs),
      },
      hotkeys: {
        mark: migrateBinding(raw.hotkeys?.mark, defaults.hotkeys.mark),
        issue: migrateBinding(raw.hotkeys?.issue, defaults.hotkeys.issue),
        labels: {
          mark: cleanLabel(raw.hotkeys?.labels?.mark, defaults.hotkeys.labels.mark),
          issue: cleanLabel(raw.hotkeys?.labels?.issue, defaults.hotkeys.labels.issue),
        },
        mode: raw.hotkeys?.mode ?? defaults.hotkeys.mode,
      },
      telemetry: { ...defaults.telemetry, ...raw.telemetry },
      pipeline: normalizePipeline(raw.pipeline),
      sessionsDir: raw.sessionsDir ?? defaults.sessionsDir,
      helperPath: raw.helperPath ?? defaults.helperPath,
      // Configs from before the wizard existed belong to users who already
      // set OBS up by hand: don't ambush them with onboarding.
      setupDone: raw.setupDone ?? true,
    };
  } catch {
    return defaults;
  }
}

export function saveConfig(config: RecorderConfig): void {
  mkdirSync(app.getPath('userData'), { recursive: true });
  const obs: StoredObsConfig = { host: config.obs.host, port: config.obs.port };
  if (config.obs.password) {
    if (safeStorage.isEncryptionAvailable()) {
      obs.passwordEncrypted = safeStorage.encryptString(config.obs.password).toString('base64');
    } else {
      obs.password = config.obs.password;
    }
  }
  writeFileSync(configPath(), JSON.stringify({ ...config, obs }, null, 2), 'utf8');
}
