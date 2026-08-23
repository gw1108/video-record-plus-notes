/**
 * IPC contract between the Electron main process and the renderer.
 * Types only — this file must stay import-type-only w.r.t. @playtest/shared so
 * the compiled renderer JS carries no module imports the browser can't load.
 */
import type { CaptureTargetKind, Mark, SessionEvent } from '@playtest/shared';

export interface ObsConnectionConfig {
  host: string;
  port: number;
  /**
   * Write-only across IPC: `config:get` always returns '' here (the real
   * value lives encrypted at rest in main). Submitting '' via `config:set`
   * keeps the stored password; submitting a value replaces it.
   */
  password: string;
  /** Renderer-facing: true when a password is stored in the main process. */
  passwordSet?: boolean;
}

export interface HotkeyConfig {
  /** Electron accelerator for the primary mark, e.g. "F8". */
  mark: string;
  /** Electron accelerator for the "issue" mark, e.g. "F9". */
  issue: string;
  /**
   * How mark keys are captured.
   * - 'global-shortcut': RegisterHotKey via Electron globalShortcut. Zero-cost,
   *   but the key is swallowed system-wide (the game never sees it) and a few
   *   exclusive-fullscreen titles fail to coexist with it (§3.3).
   * - 'raw-input': spawn the native capture-helper, which listens via Raw
   *   Input RIDEV_INPUTSINK. Does NOT swallow the key. Requires the helper
   *   binary to be built (helper/capture-helper).
   */
  mode: 'global-shortcut' | 'raw-input';
}

export interface TelemetryConfig {
  enabled: boolean;
  /** Endpoint an instrumented game serves, see docs/telemetry-protocol.md. */
  url: string;
  pollIntervalMs: number;
}

export interface RecorderConfig {
  obs: ObsConnectionConfig;
  hotkeys: HotkeyConfig;
  telemetry: TelemetryConfig;
  /** Where per-session directories (sidecar, pipeline output) are created. */
  sessionsDir: string;
  /** Path to capture-helper.exe; auto-detected from the repo when empty. */
  helperPath: string;
}

export type PreflightStatus = 'pass' | 'warn' | 'fail';

export interface PreflightCheck {
  id: string;
  label: string;
  status: PreflightStatus;
  detail: string;
  /** True when "Apply recommended settings" can fix this check. */
  fixable: boolean;
}

export interface ObsConnectResult {
  connected: boolean;
  obsVersion?: string;
  obsWebSocketVersion?: string;
  recordDirectory?: string;
  error?: string;
}

/** Result of reading (and optionally enabling) OBS's own websocket config. */
export interface ObsAutoDetectResult {
  ok: boolean;
  /** Where OBS's obs-websocket plugin config lives. */
  configPath: string;
  /** False when OBS has never been run / the plugin config is missing. */
  found: boolean;
  /** State of OBS's WebSocket server AFTER this call. */
  serverEnabled: boolean;
  /** True when this call flipped it on by editing OBS's config. */
  enabledNow: boolean;
  /** True when OBS was running, so the config could not be edited safely. */
  obsRunning: boolean;
  port?: number;
  passwordSet?: boolean;
  /** Human-readable next step for the log. */
  message: string;
}

export interface StartSessionRequest {
  title: string;
  targetKind: CaptureTargetKind;
  targetName?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  sessionDir: string;
  recordingFile?: string;
  durationMs: number;
  markCount: number;
  marks: Mark[];
  events: SessionEvent[];
  /** Ready-to-copy command for the post-session pipeline. */
  pipelineCommand: string;
}

export type RecorderState = 'idle' | 'recording' | 'paused';

export interface StatusSnapshot {
  state: RecorderState;
  obsConnected: boolean;
  sessionId?: string;
  sessionTitle?: string;
  recordingMs?: number;
  markCount?: number;
  telemetryConnected?: boolean;
}

/** Events pushed main → renderer over the 'recorder:event' channel. */
export type RecorderPushEvent =
  | { type: 'status'; status: StatusSnapshot }
  | { type: 'mark-added'; mark: Mark }
  | { type: 'session-stopped'; summary: SessionSummary }
  | { type: 'obs-connection'; connected: boolean; error?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/** The API surface preload exposes as `window.playtest`. */
export interface PlaytestApi {
  getConfig(): Promise<RecorderConfig>;
  setConfig(config: RecorderConfig): Promise<RecorderConfig>;
  obsConnect(): Promise<ObsConnectResult>;
  obsAutoDetect(): Promise<ObsAutoDetectResult>;
  obsPreflight(): Promise<PreflightCheck[]>;
  obsApplyRecommended(): Promise<PreflightCheck[]>;
  startSession(req: StartSessionRequest): Promise<{ ok: boolean; error?: string }>;
  stopSession(): Promise<{ ok: boolean; summary?: SessionSummary; error?: string }>;
  getStatus(): Promise<StatusSnapshot>;
  onEvent(callback: (event: RecorderPushEvent) => void): () => void;
}

export const IPC = {
  getConfig: 'config:get',
  setConfig: 'config:set',
  obsConnect: 'obs:connect',
  obsAutoDetect: 'obs:auto-detect',
  obsPreflight: 'obs:preflight',
  obsApplyRecommended: 'obs:apply-recommended',
  startSession: 'session:start',
  stopSession: 'session:stop',
  getStatus: 'session:status',
  pushEvent: 'recorder:event',
} as const;
