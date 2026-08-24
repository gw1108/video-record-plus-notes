/**
 * Electron main process entry. Wires config, OBS client, session controller,
 * tray, window lifecycle, and IPC.
 *
 * Window policy (perf report §4.3): the setup/review window exists only while
 * idle. Starting a session CLOSES every BrowserWindow — the live hot path
 * (hotkey → anchor → sidecar) runs renderer-free with just the tray icon.
 */
import { app, BrowserWindow, ipcMain, Notification, shell } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatTimecode } from '@playtest/shared';
import type {
  ObsAutoDetectResult,
  ObsConnectResult,
  RecorderConfig,
  RecorderPushEvent,
  SessionSummary,
  StartSessionRequest,
} from '../common/ipc-contract.js';
import { rigAdvisories } from './advisory.js';
import { loadConfig, normalizePipeline, saveConfig } from './config.js';
import { findHelperBinary, GamepadCaptureHelper } from './helper.js';
import { ObsClient } from './obs.js';
import {
  enableObsWebsocketServer,
  findObsInstall,
  obsIsRunning,
  readObsWebsocketSettings,
} from './obs-config.js';
import { PipelineRunner } from './pipeline.js';
import { applyRecommended, runPreflight } from './preflight.js';
import { SessionController } from './recording.js';
import { entryFor, listSessions, REPORT_RELATIVE_PATH } from './sessions.js';
import { RecorderTray } from './tray.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** `electron . --smoke`: boot, load the renderer, print a verdict, exit. */
const SMOKE = process.argv.includes('--smoke');

let config: RecorderConfig;
const obs = new ObsClient();
const controller = new SessionController(obs);
const pipeline = new PipelineRunner();
let tray: RecorderTray | null = null;
let mainWindow: BrowserWindow | null = null;
let pendingSummary: SessionSummary | null = null;
let quitting = false;
let tooltipTimer: NodeJS.Timeout | null = null;
let smokeFailed = false;
let gamepadCapture: GamepadCaptureHelper | null = null;

function stopGamepadCapture(): void {
  gamepadCapture?.stop();
  gamepadCapture = null;
}

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
    // The window can already be open when a session ends (reopened from the
    // tray mid-recording); did-finish-load won't fire again, so flush here.
    if (pendingSummary) {
      broadcast({ type: 'session-stopped', summary: pendingSummary });
      pendingSummary = null;
    }
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
    stopGamepadCapture(); // an armed capture button dies with its window
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
  stopGamepadCapture(); // an armed capture button dies with its window
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

async function handlePause(): Promise<{ ok: boolean; error?: string }> {
  try {
    await controller.pause();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    controller.emit('log', 'warn', `Pause: ${message}`);
    notify('Pause not applied', message);
    return { ok: false, error: message };
  }
}

async function handleResume(): Promise<{ ok: boolean; error?: string }> {
  try {
    await controller.resume();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    controller.emit('log', 'warn', `Resume: ${message}`);
    return { ok: false, error: message };
  }
}

/**
 * Spawn the post-session pipeline for one session dir. Refused while a
 * session is live: STT/VAD/FFmpeg are exactly the load that must never
 * overlap recording (perf report §1).
 */
function startPipeline(sessionDir: string): { ok: boolean; error?: string } {
  if (controller.recording) return { ok: false, error: 'Cannot run the pipeline while recording.' };
  if (pipeline.running) return { ok: false, error: `Pipeline already running for ${pipeline.running}.` };
  if (!entryFor(sessionDir)) return { ok: false, error: `No session sidecar in ${sessionDir}.` };
  try {
    pipeline.run(config.pipeline, sessionDir);
    return { ok: true };
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
    config = {
      ...next,
      obs: { host: next.obs.host, port: next.obs.port, password },
      pipeline: normalizePipeline(next.pipeline),
    };
    saveConfig(config);
    tray?.setMarkHotkeyLabel(config.hotkeys.mark.label);
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

  ipcMain.handle('obs:auto-detect', async (): Promise<ObsAutoDetectResult> => {
    const settings = readObsWebsocketSettings();
    if (!settings.found) {
      return {
        ok: false,
        configPath: settings.path,
        found: false,
        serverEnabled: false,
        enabledNow: false,
        obsRunning: await obsIsRunning(),
        message: `No obs-websocket config at ${settings.path}. Install and run OBS Studio 30.2+ once, then try again.`,
      };
    }

    // Adopt OBS's own port/password. Auth off in OBS means connect with none.
    config = {
      ...config,
      obs: {
        host: '127.0.0.1',
        port: settings.port,
        password: settings.authRequired ? settings.password : '',
      },
    };
    saveConfig(config);

    const base = {
      configPath: settings.path,
      found: true,
      port: settings.port,
      passwordSet: config.obs.password.length > 0,
    };

    if (settings.serverEnabled) {
      return {
        ...base,
        ok: true,
        serverEnabled: true,
        enabledNow: false,
        obsRunning: await obsIsRunning(),
        message: `Read OBS settings: port ${settings.port}, ${settings.authRequired ? 'password adopted' : 'no auth'}. Server already enabled — press Connect.`,
      };
    }

    // Server is off. OBS rewrites this file from memory on exit, so editing it
    // under a running OBS would be silently reverted.
    if (await obsIsRunning()) {
      return {
        ...base,
        ok: false,
        serverEnabled: false,
        enabledNow: false,
        obsRunning: true,
        message: `Port ${settings.port} and password adopted, but OBS's WebSocket server is off and OBS is running. Enable it in OBS → Tools → WebSocket Server Settings (or quit OBS and click Auto-detect again).`,
      };
    }

    try {
      enableObsWebsocketServer();
    } catch (err) {
      return {
        ...base,
        ok: false,
        serverEnabled: false,
        enabledNow: false,
        obsRunning: false,
        message: `Could not enable OBS's WebSocket server (${String(err)}). Enable it manually in OBS → Tools → WebSocket Server Settings.`,
      };
    }
    return {
      ...base,
      ok: true,
      serverEnabled: true,
      enabledNow: true,
      obsRunning: false,
      message: `Enabled OBS's WebSocket server on port ${settings.port} (backup written next to ${settings.path}). Start OBS, then press Connect.`,
    };
  });

  ipcMain.handle('obs:preflight', () => runPreflight(obs));
  ipcMain.handle('obs:apply-recommended', () => applyRecommended(obs));
  ipcMain.handle('obs:detect-install', () => findObsInstall());
  ipcMain.handle('rig:advisories', () => rigAdvisories());

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
  ipcMain.handle('session:pause', () => handlePause());
  ipcMain.handle('session:resume', () => handleResume());
  ipcMain.handle('session:status', () => controller.statusSnapshot());

  // Session browser: read-only listing of sessionsDir + open/run actions.
  ipcMain.handle('sessions:list', () => listSessions(config.sessionsDir));
  ipcMain.handle('sessions:open-report', async (_e, sessionDir: string) => {
    if (!entryFor(sessionDir)) return { ok: false, error: 'Not a session directory.' };
    const report = join(sessionDir, REPORT_RELATIVE_PATH);
    if (!existsSync(report)) return { ok: false, error: 'No report yet — run the pipeline first.' };
    const error = await shell.openPath(report);
    return error ? { ok: false, error } : { ok: true };
  });
  ipcMain.handle('sessions:open-folder', async (_e, sessionDir: string) => {
    if (!entryFor(sessionDir)) return { ok: false, error: 'Not a session directory.' };
    const error = await shell.openPath(sessionDir);
    return error ? { ok: false, error } : { ok: true };
  });
  ipcMain.handle('pipeline:run', (_e, sessionDir: string) => startPipeline(sessionDir));
  ipcMain.handle('pipeline:cancel', () => pipeline.cancel());

  // Controller/HID capture for the binding buttons: run the helper's capture
  // mode and forward each identified press to the renderer. Keyboard/mouse
  // capture never comes through here (plain DOM events in the renderer).
  ipcMain.handle('capture:gamepad-start', () => {
    if (controller.recording) return { ok: false, error: 'Cannot rebind while recording.' };
    const binary = findHelperBinary(config.helperPath);
    if (!binary) {
      return {
        ok: false,
        error: 'capture-helper.exe not found — controller/pedal capture unavailable (keyboard and mouse still work). Build it with: cargo build --release (in helper/capture-helper).',
      };
    }
    stopGamepadCapture();
    gamepadCapture = new GamepadCaptureHelper();
    gamepadCapture.on('input', (binding) => broadcast({ type: 'capture-input', binding }));
    gamepadCapture.start(binary);
    return { ok: true };
  });
  ipcMain.handle('capture:gamepad-stop', () => stopGamepadCapture());
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
    const autoRun = config.pipeline.autoRun;
    notify(
      'Recording stopped',
      `${summary.markCount} marks — ${formatTimecode(summary.durationMs)}. ` +
        (autoRun ? 'Running the post-session pipeline…' : 'Next: run the post-session pipeline.'),
    );
    pendingSummary = summary;
    createMainWindow();
    if (autoRun) {
      const result = startPipeline(summary.sessionDir);
      if (!result.ok) controller.emit('log', 'warn', `Auto-run pipeline: ${result.error}`);
    }
  });

  pipeline.on('started', (sessionDir: string, command: string) => {
    broadcast({ type: 'pipeline-started', sessionDir, command });
    controller.emit('log', 'info', `pipeline: ${command}`);
  });
  pipeline.on('line', (sessionDir: string, line: string) => broadcast({ type: 'pipeline-output', sessionDir, line }));
  pipeline.on('done', (sessionDir: string, code: number | null, reportPath?: string) => {
    broadcast({ type: 'pipeline-done', sessionDir, code, reportPath });
    if (code === 0 && reportPath) notify('Report ready', reportPath);
    else notify('Pipeline failed', `Exit code ${code ?? 'unknown'} — see the log in the recorder window.`);
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
      onPause: () => void handlePause(),
      onResume: () => void handleResume(),
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
    tray.setMarkHotkeyLabel(config.hotkeys.mark.label);

    controller.on('status', (status) => {
      if (status.state !== 'idle') {
        tray?.setRecording(true, status.state === 'paused');
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
