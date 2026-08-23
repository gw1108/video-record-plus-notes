/**
 * Reads (and, when safe, writes) OBS's own obs-websocket plugin settings so
 * the user never has to copy host/port/password out of OBS by hand.
 *
 * The plugin stores its config at
 *   %APPDATA%\obs-studio\plugin_config\obs-websocket\config.json
 * and rewrites that file from memory when OBS exits — so enabling the server
 * by editing it is only sound while OBS is NOT running. When OBS is up we
 * report back and let the user flip it in Tools → WebSocket Server Settings.
 */
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';

const execFileAsync = promisify(execFile);

/** On-disk shape (only the keys we care about; the rest is preserved). */
interface ObsWebsocketFile {
  server_enabled?: boolean;
  auth_required?: boolean;
  server_password?: string;
  server_port?: number;
  [key: string]: unknown;
}

export interface ObsWebsocketSettings {
  path: string;
  found: boolean;
  serverEnabled: boolean;
  authRequired: boolean;
  port: number;
  password: string;
}

export function obsWebsocketConfigPath(): string {
  return join(
    app.getPath('appData'),
    'obs-studio',
    'plugin_config',
    'obs-websocket',
    'config.json',
  );
}

export function readObsWebsocketSettings(): ObsWebsocketSettings {
  const path = obsWebsocketConfigPath();
  const empty: ObsWebsocketSettings = {
    path,
    found: false,
    serverEnabled: false,
    authRequired: true,
    port: 4455,
    password: '',
  };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as ObsWebsocketFile;
    return {
      path,
      found: true,
      serverEnabled: raw.server_enabled === true,
      authRequired: raw.auth_required !== false,
      port: typeof raw.server_port === 'number' ? raw.server_port : 4455,
      password: typeof raw.server_password === 'string' ? raw.server_password : '',
    };
  } catch {
    return empty;
  }
}

/** True when an OBS process is up — its exit would clobber our file write. */
export async function obsIsRunning(): Promise<boolean> {
  for (const image of ['obs64.exe', 'obs32.exe']) {
    try {
      const { stdout } = await execFileAsync('tasklist', [
        '/FI',
        `IMAGENAME eq ${image}`,
        '/NH',
      ]);
      if (stdout.toLowerCase().includes(image)) return true;
    } catch {
      /* tasklist unavailable — assume not running and let the write proceed */
    }
  }
  return false;
}

/**
 * Flip `server_enabled` on in OBS's plugin config, keeping a one-time backup
 * of the original next to it. Caller must have checked OBS is not running.
 */
export function enableObsWebsocketServer(): void {
  const path = obsWebsocketConfigPath();
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ObsWebsocketFile;
  const backup = `${path}.playtest-backup`;
  if (!existsSync(backup)) copyFileSync(path, backup);
  raw.server_enabled = true;
  writeFileSync(path, `${JSON.stringify(raw, null, 4)}\n`, 'utf8');
}
