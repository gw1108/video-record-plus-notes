import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecorderConfig } from '../common/ipc-contract.js';

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

export function defaultConfig(): RecorderConfig {
  return {
    obs: { host: '127.0.0.1', port: 4455, password: '' },
    hotkeys: { mark: 'F8', issue: 'F9', mode: 'global-shortcut' },
    telemetry: {
      enabled: false,
      url: 'http://127.0.0.1:46333/playtest/time',
      pollIntervalMs: 500,
    },
    sessionsDir: join(app.getPath('videos'), 'PlaytestSessions'),
    helperPath: '',
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
      hotkeys: { ...defaults.hotkeys, ...raw.hotkeys },
      telemetry: { ...defaults.telemetry, ...raw.telemetry },
      sessionsDir: raw.sessionsDir ?? defaults.sessionsDir,
      helperPath: raw.helperPath ?? defaults.helperPath,
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
