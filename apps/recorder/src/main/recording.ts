/**
 * SessionController — owns one recording session end to end:
 * StartRecord/StopRecord over obs-websocket, mark hotkeys, the sidecar
 * (source of truth), redundant MP4 chapters, telemetry stamping, and
 * OBS-reconnect resilience. Lives entirely in the Electron main process; all
 * BrowserWindows are closed while it runs (perf report §4.3).
 */
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { globalShortcut } from 'electron';
import {
  formatTimecode,
  type Mark,
  type SessionEvent,
  type SessionEventType,
  type SessionInfo,
} from '@playtest/shared';
import type {
  RecorderConfig,
  SessionSummary,
  StartSessionRequest,
  StatusSnapshot,
} from '../common/ipc-contract.js';
import type { ObsClient, RecordStateEvent } from './obs.js';
import { MarkAnchorService } from './marks.js';
import { SidecarWriter } from './sidecar.js';
import { TelemetryPoller } from './telemetry.js';
import { findHelperBinary, RawInputHelper } from './helper.js';
import { monoMs, uniqueSessionId } from './util.js';

const START_TIMEOUT_MS = 10_000;
const TELEMETRY_LOG_INTERVAL_MS = 5000;
const RECONNECT_INTERVAL_MS = 3000;

export class SessionController extends EventEmitter {
  private sidecar: SidecarWriter | null = null;
  private anchor: MarkAnchorService;
  private telemetry: TelemetryPoller | null = null;
  private helper: RawInputHelper | null = null;
  private state: 'idle' | 'recording' | 'paused' = 'idle';
  private seq = 0;
  private startMonoMs = 0;
  private lastOutputDurationMs = 0;
  private lastOutputSampleMonoMs = 0;
  private telemetryTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stoppingViaApp = false;
  private registeredAccelerators: string[] = [];

  constructor(private readonly obs: ObsClient) {
    super();
    this.anchor = new MarkAnchorService(obs);
    obs.on('record-state', (e: RecordStateEvent) => this.onRecordState(e));
    obs.on('disconnected', () => this.onObsDisconnected());
  }

  get recording(): boolean {
    return this.state !== 'idle';
  }

  async start(config: RecorderConfig, req: StartSessionRequest): Promise<void> {
    if (this.state !== 'idle') throw new Error('A session is already running.');
    if (!this.obs.connected) throw new Error('Not connected to OBS.');

    const startedAt = new Date();
    const id = uniqueSessionId(config.sessionsDir, req.title, startedAt);
    const sessionDir = join(config.sessionsDir, id);

    const session: SessionInfo = {
      id,
      title: req.title || id,
      startedAtWall: startedAt.toISOString(),
      captureTarget: { kind: req.targetKind, name: req.targetName },
    };
    try {
      const version = await this.obs.getVersion();
      session.obs = {
        obsVersion: version.obsVersion,
        obsWebSocketVersion: version.obsWebSocketVersion,
        recFormat: (await this.obs.getProfileParameter('AdvOut', 'RecFormat2')) ?? undefined,
        recTracks: (await this.obs.getProfileParameter('AdvOut', 'RecTracks')) ?? undefined,
      };
    } catch {
      // metadata only; never block a session on it
    }

    this.sidecar = new SidecarWriter(sessionDir, session);
    this.seq = 0;

    try {
      const started = this.waitForOutputState('OBS_WEBSOCKET_OUTPUT_STARTED', START_TIMEOUT_MS);
      // If startRecord() throws, nothing ever awaits `started` and its
      // timeout would surface as an unhandled rejection ~10 s later.
      started.catch(() => {});
      await this.obs.startRecord();
      await started;
    } catch (err) {
      this.discardFailedStart(sessionDir);
      throw err;
    }

    this.startMonoMs = monoMs();
    this.state = 'recording';
    this.logEvent('record-started');
    this.anchor.start();
    this.startTelemetry(config);
    this.registerHotkeys(config);
    this.emitStatus();
  }

  /**
   * A failed start must not leave an open journal fd or a junk session dir
   * behind — a same-second retry would otherwise append a second `session`
   * line into the abandoned journal. The dir was freshly created by this
   * start() (uniqueSessionId probes for collisions), so removing it is safe.
   */
  private discardFailedStart(sessionDir: string): void {
    const sidecar = this.sidecar;
    this.sidecar = null;
    try {
      sidecar?.close();
    } catch {
      // best effort; the fd is dropped either way
    }
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // a leftover dir is cosmetic; never mask the original start error
    }
  }

  private startTelemetry(config: RecorderConfig): void {
    if (!config.telemetry.enabled) return;
    this.telemetry = new TelemetryPoller(config.telemetry);
    this.telemetry.on('connected', () => this.logEvent('telemetry-connected'));
    this.telemetry.on('lost', () => this.logEvent('telemetry-lost'));
    this.telemetry.start();
    this.telemetryTimer = setInterval(() => {
      const s = this.telemetry?.sample();
      if (s && this.sidecar) this.sidecar.addTelemetry(s);
    }, TELEMETRY_LOG_INTERVAL_MS);
  }

  private registerHotkeys(config: RecorderConfig): void {
    const keys: Record<string, string> = {
      mark: config.hotkeys.mark,
      issue: config.hotkeys.issue,
    };
    if (config.hotkeys.mode === 'raw-input') {
      const binary = findHelperBinary(config.helperPath);
      if (!binary) {
        this.log('warn', 'raw-input mode: capture-helper.exe not found; falling back to globalShortcut. Build it with: cargo build --release (in helper/capture-helper).');
      } else {
        this.helper = new RawInputHelper();
        this.helper.on('hotkey', (e) => void this.mark(e.label, keys[e.label], e.pressMonoMs));
        this.helper.on('error', (err: Error) => this.log('warn', `helper: ${err.message}`));
        this.helper.on('log', (line: string) => this.log('info', `helper: ${line}`));
        this.helper.on('exit', (code: number | null) =>
          this.log(code === 0 ? 'info' : 'warn', `helper exited (code ${code})`),
        );
        this.helper.start(binary, keys);
        return;
      }
    }
    // globalShortcut → Win32 RegisterHotKey. The key is swallowed system-wide:
    // pick keys the game doesn't use (§3.3). Registered only while recording.
    for (const [label, accel] of Object.entries(keys)) {
      const pressLabel = label;
      const ok = globalShortcut.register(accel, () => {
        const pressMonoMs = monoMs(); // stamp before any async work
        void this.mark(pressLabel, accel, pressMonoMs);
      });
      if (ok) this.registeredAccelerators.push(accel);
      else this.log('warn', `Could not register hotkey ${accel} (in use by another app?)`);
    }
  }

  private unregisterHotkeys(): void {
    for (const accel of this.registeredAccelerators) globalShortcut.unregister(accel);
    this.registeredAccelerators = [];
    this.helper?.stop();
    this.helper = null;
  }

  /** Record a mark. Callable from hotkey, tray menu, or IPC. */
  async mark(label: string, hotkey?: string, pressMonoMs = monoMs()): Promise<Mark | null> {
    if (this.state === 'idle' || !this.sidecar) return null;
    this.seq += 1;
    const seq = this.seq;
    const { videoMs, anchor } = await this.anchor.anchorPress(pressMonoMs);
    const mark: Mark = {
      id: `m${seq}`,
      seq,
      kind: 'manual',
      label,
      hotkey,
      monoMs: pressMonoMs,
      videoMs,
      gameTimeMs: this.telemetry?.gameTimeAt(pressMonoMs) ?? null,
      anchor,
    };
    this.sidecar.addMark(mark);
    this.emit('mark-added', mark);
    this.emitStatus();

    // Redundant chapter in the Hybrid MP4 (lost on OBS crash; sidecar rules).
    const chapterName = `#${seq} ${label}${videoMs !== null ? ` @ ${formatTimecode(videoMs)}` : ''}`;
    this.obs.createRecordChapter(chapterName).catch((err: unknown) => {
      this.logEvent('chapter-create-failed', String(err));
    });
    return mark;
  }

  async stop(): Promise<SessionSummary> {
    if (this.state === 'idle' || !this.sidecar) throw new Error('No session running.');
    this.stoppingViaApp = true;
    let outputPath: string | undefined;
    try {
      const stopped = this.waitForOutputState('OBS_WEBSOCKET_OUTPUT_STOPPED', START_TIMEOUT_MS);
      // Consumed below unless stopRecord() throws first; without this, a
      // failed stop leaves the waiter to reject unhandled on timeout.
      stopped.catch(() => {});
      outputPath = await this.obs.stopRecord();
      const fromEvent = await stopped;
      outputPath = outputPath ?? fromEvent ?? undefined;
    } catch (err) {
      this.log('warn', `StopRecord failed (${String(err)}); finalizing sidecar anyway.`);
    }
    return this.finalize(outputPath);
  }

  private finalize(outputPath?: string): SessionSummary {
    const sidecar = this.sidecar!;
    this.logEvent('record-stopped');
    sidecar.end(new Date().toISOString(), outputPath);

    this.unregisterHotkeys();
    this.anchor.stop();
    this.telemetry?.stop();
    this.telemetry = null;
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.telemetryTimer = null;
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    this.reconnectTimer = null;

    const durationMs = Math.round(monoMs() - this.startMonoMs);
    const data = sidecar.data;
    const summary: SessionSummary = {
      id: data.session.id,
      title: data.session.title,
      sessionDir: sidecar.sessionDir,
      recordingFile: data.session.recordingFile,
      durationMs,
      markCount: data.marks.length,
      marks: data.marks,
      events: data.events,
      pipelineCommand: `playtest-pipeline process "${sidecar.sessionDir}"`,
    };

    this.sidecar = null;
    this.state = 'idle';
    this.stoppingViaApp = false;
    this.emit('stopped', summary);
    this.emitStatus();
    return summary;
  }

  private onRecordState(e: RecordStateEvent): void {
    if (this.state === 'idle') return;
    switch (e.outputState) {
      case 'OBS_WEBSOCKET_OUTPUT_PAUSED':
        this.state = 'paused';
        this.anchor.onPauseBoundary(true);
        this.logEvent('record-paused');
        this.emitStatus();
        break;
      case 'OBS_WEBSOCKET_OUTPUT_RESUMED':
        this.state = 'recording';
        this.anchor.onPauseBoundary(false);
        this.logEvent('record-resumed');
        this.emitStatus();
        break;
      case 'OBS_WEBSOCKET_OUTPUT_STOPPED':
        // Stopped from the OBS UI (not via this app): finalize gracefully.
        if (!this.stoppingViaApp) {
          this.log('warn', 'Recording was stopped from OBS directly; finalizing session.');
          this.finalize(e.outputPath ?? undefined);
        }
        break;
    }
  }

  private onObsDisconnected(): void {
    if (this.state === 'idle') return;
    // OBS (or the socket) went away mid-session. OBS keeps recording on its
    // own; marks keep working through the calibrated fallback. Reconnect in
    // the background.
    this.logEvent('obs-disconnected');
    this.log('warn', 'Lost obs-websocket connection; retrying in the background. Marks still work (calibrated).');
    this.reconnectTimer = setInterval(() => void this.tryReconnect(), RECONNECT_INTERVAL_MS);
  }

  private lastConfig: RecorderConfig | null = null;
  setConfigForReconnect(config: RecorderConfig): void {
    this.lastConfig = config;
  }

  private async tryReconnect(): Promise<void> {
    if (!this.lastConfig || this.obs.connected) return;
    try {
      await this.obs.connect(this.lastConfig.obs);
    } catch {
      return; // keep retrying
    }
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    this.reconnectTimer = null;
    this.logEvent('obs-reconnected');
    this.log('info', 'Reconnected to OBS.');
    // If OBS itself restarted, the output is gone: direct anchors would stamp
    // garbage and the session can't continue. Finalize with whatever file OBS
    // salvaged; the pipeline handles marks past the salvaged end.
    if (this.state !== 'idle') {
      try {
        const status = await this.obs.sampleRecordStatus();
        if (!status.active) {
          this.log('warn', 'OBS is no longer recording after reconnect; finalizing the session.');
          this.finalize();
        }
      } catch {
        // status check failed; leave the session running — marks fall back
        // to the calibrated anchor until the next successful sample
      }
    }
  }

  private waitForOutputState(state: string, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.obs.off('record-state', handler);
        reject(new Error(`Timed out waiting for ${state}`));
      }, timeoutMs);
      const handler = (e: RecordStateEvent) => {
        if (e.outputState === state) {
          clearTimeout(timer);
          this.obs.off('record-state', handler);
          resolve(e.outputPath);
        }
      };
      this.obs.on('record-state', handler);
    });
  }

  async statusSnapshot(): Promise<StatusSnapshot> {
    const base: StatusSnapshot = {
      state: this.state,
      obsConnected: this.obs.connected,
    };
    if (this.state === 'idle' || !this.sidecar) return base;
    let recordingMs = this.lastOutputDurationMs + (monoMs() - this.lastOutputSampleMonoMs);
    if (this.obs.connected) {
      try {
        const s = await this.obs.sampleRecordStatus();
        this.lastOutputDurationMs = s.sample.outputDurationMs;
        this.lastOutputSampleMonoMs = s.sample.recvMonoMs;
        recordingMs = s.sample.outputDurationMs;
      } catch {
        // estimate from last sample
      }
    }
    return {
      ...base,
      sessionId: this.sidecar.data.session.id,
      sessionTitle: this.sidecar.data.session.title,
      recordingMs: Math.max(0, Math.round(recordingMs)),
      markCount: this.sidecar.data.marks.length,
      telemetryConnected: this.telemetry?.connected ?? false,
    };
  }

  private logEvent(type: SessionEventType, detail?: string): void {
    if (!this.sidecar) return;
    const event: SessionEvent = { type, monoMs: monoMs(), detail };
    this.sidecar.addEvent(event);
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.emit('log', level, message);
  }

  private emitStatus(): void {
    void this.statusSnapshot().then((s) => this.emit('status', s));
  }
}
