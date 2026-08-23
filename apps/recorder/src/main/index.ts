/**
 * Electron main process entry. Wires config, OBS client, session controller,
 * tray, window lifecycle, and IPC.
 *
 * Window policy (perf report §4.3): the setup/review window exists only while
 * idle. Starting a session CLOSES every BrowserWindow — the live hot path
 * (hotkey → anchor → sidecar) runs renderer-free with just the tray icon.
 */
import { app, BrowserWindow, ipcMain, Notification } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatTimecode } from '@playtest/shared';
import type {
  ObsConnectResult,
  RecorderConfig,
  RecorderPushEvent,
  SessionSummary,
  StartSessionRequest,
} from '../common/ipc-contract.js';
import { loadConfig, saveConfig } from './config.js';
import { ObsClient } from './obs.js';
import { applyRecommended, runPreflight } from './preflight.js';
import { SessionController } from './recording.js';
import { RecorderTray } from './tray.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** `electron . --smoke`: boot, load the renderer, print a verdict, exit. */
const SMOKE = process.argv.includes('--smoke');

let config: RecorderConfig;
const obs = new ObsClient();
const controller = new SessionController(obs);
let tray: RecorderTray | null = null;
let mainWindow: BrowserWindow | null = null;
let pendingSummary: SessionSummary | null = null;
let quitting = false;
let tooltipTimer: NodeJS.Timeout | null = null;
let smokeFailed = false;

function broadcast(event: RecorderPushEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('recorder:event', event);
  }
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

function createMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 760,
    height: 860,
    title: 'Playtest Recorder',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingSummary) {
      broadcast({ type: 'session-stopped', summary: pendingSummary });
      pendingSummary = null;
    }
    if (SMOKE) {
      // Give the renderer a moment to run init() so preload/IPC failures surface.
      setTimeout(() => {
        console.log('[smoke] renderer loaded OK');
        app.exit(smokeFailed ? 1 : 0);
      }, 1000);
    }
  });
  if (SMOKE) {
    mainWindow.webContents.on('console-message', (event) => {
      const { level, message } = event as unknown as { level: string; message: string };
      if (String(level) === 'error' || Number(level) >= 3) {
        smokeFailed = true;
        console.error(`[smoke] renderer error: ${message}`);
      }
    });
  }
  void mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
}

function closeAllWindows(): void {
  for (const win of BrowserWindow.getAllWindows()) win.close();
  mainWindow = null;
}

function startTooltipTimer(): void {
  tooltipTimer = setInterval(() => {
    void controller.statusSnapshot().then((s) => {
      if (s.state === 'idle') return;
      const rec = formatTimecode(s.recordingMs ?? 0);
      const paused = s.state === 'paused' ? ' (paused)' : '';
      tray?.setTooltip(`REC ${rec}${paused} — ${s.markCount ?? 0} marks — ${s.sessionTitle ?? ''}`);
    });
  }, 5000);
}

function stopTooltipTimer(): void {
  if (tooltipTimer) clearInterval(tooltipTimer);
  tooltipTimer = null;
}

async function handleStop(): Promise<{ ok: boolean; summary?: SessionSummary; error?: string }> {
  try {
    const summary = await controller.stop();
    return { ok: true, summary };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** The OBS password is write-only across IPC: never send it to the renderer. */
function redactedConfig(): RecorderConfig {
  return {
    ...config,
    obs: { ...config.obs, password: '', passwordSet: config.obs.password.length > 0 },
  };
}

function registerIpc(): void {
  ipcMain.handle('config:get', () => redactedConfig());
  ipcMain.handle('config:set', (_e, next: RecorderConfig) => {
    // An empty password from the renderer means "keep the stored one" (the
    // form is populated from the redacted config, so blank is the norm).
    const password = next.obs.password || config.obs.password;
    config = { ...next, obs: { host: next.obs.host, port: next.obs.port, password } };
    saveConfig(config);
    tray?.setMarkHotkeyLabel(config.hotkeys.mark);
    return redactedConfig();
  });

  ipcMain.handle('obs:connect', async (): Promise<ObsConnectResult> => {
    try {
      if (obs.connected) await obs.disconnect();
      await obs.connect(config.obs);
      const version = await obs.getVersion();
      let recordDirectory: string | undefined;
      try {
        recordDirectory = await obs.getRecordDirectory();
      } catch {
        /* optional */
      }
      return { connected: true, ...version, recordDirectory };
    } catch (err) {
      return { connected: false, error: String(err) };
    }
  });

  ipcMain.handle('obs:preflight', () => runPreflight(obs));
  ipcMain.handle('obs:apply-recommended', () => applyRecommended(obs));

  ipcMain.handle('session:start', async (_e, req: StartSessionRequest) => {
    try {
      controller.setConfigForReconnect(config);
      await controller.start(config, req);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('session:stop', () => handleStop());
  ipcMain.handle('session:status', () => controller.statusSnapshot());
}

function wireController(): void {
  controller.on('status', (status) => broadcast({ type: 'status', status }));
  controller.on('mark-added', (mark) => broadcast({ type: 'mark-added', mark }));
  controller.on('log', (level, message) => {
    console.log(`[${level}] ${message}`);
    broadcast({ type: 'log', level, message });
  });

  controller.on('status', (status) => {
    // Transition into recording: drop to tray-only.
    if (status.state !== 'idle' && BrowserWindow.getAllWindows().length > 0) {
      closeAllWindows();
    }
  });

  controller.on('stopped', (summary: SessionSummary) => {
    stopTooltipTimer();
    tray?.setRecording(false);
    notify(
      'Recording stopped',
      `${summary.markCount} marks — ${formatTimecode(summary.durationMs)}. Next: run the post-session pipeline.`,
    );
    pendingSummary = summary;
    createMainWindow();
  });

  obs.on('connected', () => broadcast({ type: 'obs-connection', connected: true }));
  obs.on('disconnected', () => broadcast({ type: 'obs-connection', connected: false }));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!controller.recording) createMainWindow();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('dev.playtest.recorder');
    config = loadConfig();
    registerIpc();
    wireController();

    tray = new RecorderTray({
      onShow: () => createMainWindow(),
      onMark: () => void controller.mark('mark', undefined),
      onStop: () => void handleStop(),
      onQuit: () => {
        if (controller.recording) {
          notify('Recording in progress', 'Stop the recording before quitting.');
          return;
        }
        quitting = true;
        app.quit();
      },
    });
    tray.setMarkHotkeyLabel(config.hotkeys.mark);

    controller.on('status', (status) => {
      if (status.state !== 'idle') {
        tray?.setRecording(true);
        if (!tooltipTimer) startTooltipTimer();
      }
    });

    createMainWindow();
    if (SMOKE) {
      setTimeout(() => {
        console.error('[smoke] timed out waiting for renderer');
        app.exit(1);
      }, 15_000).unref?.();
    }
  });

  // Tray app: closing the window must not quit; quitting happens via the tray
  // (and is blocked while recording).
  app.on('window-all-closed', () => {
    /* keep running in tray */
  });

  app.on('before-quit', (e) => {
    if (controller.recording && !quitting) {
      e.preventDefault();
      notify('Recording in progress', 'Stop the recording before quitting.');
    }
  });

  app.on('activate', () => {
    if (!controller.recording) createMainWindow();
  });
}
