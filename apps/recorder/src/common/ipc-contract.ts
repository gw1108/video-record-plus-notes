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

export interface KeyModifiers {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/**
 * One physical input bound to a mark action. Set from the capture buttons in
 * the UI; matched at runtime by globalShortcut (keyboard only) or the native
 * capture-helper (everything).
 */
export type HotkeyBinding =
  | {
      /** A keyboard key — also covers keyboard-emulating foot pedals. */
      type: 'keyboard';
      /** Windows virtual-key code of the non-modifier key. */
      vk: number;
      /** Exact-match modifier chord (F8 ≠ Ctrl+F8 ≠ Ctrl+Shift+F8). */
      modifiers: KeyModifiers;
      /**
       * Electron accelerator (e.g. "Ctrl+Shift+F8") when the key has one;
       * null for keys globalShortcut can't register — those always route
       * through the capture-helper.
       */
      accelerator: string | null;
      /** Display text, e.g. "Ctrl+F8". */
      label: string;
    }
  | {
      /** A mouse button. Always routed through the capture-helper. */
      type: 'mouse';
      button: 'left' | 'right' | 'middle' | 'x1' | 'x2';
      modifiers: KeyModifiers;
      label: string;
    }
  | {
      /**
       * An XInput (Xbox-class) controller button. `code` is the
       * XINPUT_GAMEPAD_* button bitmask bit, or 0x10000 / 0x20000 for the
       * left / right trigger. Always routed through the capture-helper.
       */
      type: 'gamepad';
      code: number;
      label: string;
    }
  | {
      /**
       * A generic HID joystick / gamepad / pedal button (non-XInput).
       * Always routed through the capture-helper.
       */
      type: 'hid';
      vendorId: number;
      productId: number;
      /** Zero-based index within the device's button usage range. */
      buttonIndex: number;
      label: string;
    };

export interface HotkeyConfig {
  /** Binding for the primary mark. */
  mark: HotkeyBinding;
  /** Binding for the "issue" mark. */
  issue: HotkeyBinding;
  /**
   * Semantic labels written into the sidecar (`Mark.label`), chapter names
   * and the report for each slot. Defaults "mark" / "issue"; a team can
   * rename them ("bug", "fun", "confusing"…) without touching the pipeline.
   */
  labels: { mark: string; issue: string };
  /**
   * How KEYBOARD bindings are captured (mouse/gamepad/HID bindings always use
   * the capture-helper regardless of this mode).
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

/**
 * Post-session pipeline settings. Everything here is persisted into the
 * `playtest-pipeline process …` command the app prints (and runs, when
 * `autoRun` is on) — the pipeline itself stays a separate CLI (perf §1:
 * nothing heavy ever runs inside the recorder process).
 */
export interface PipelineConfig {
  /** Spawn the pipeline automatically when a session stops. */
  autoRun: boolean;
  /**
   * Executable (or full command line prefix) to run. Default
   * "playtest-pipeline" (the pip entry point on PATH); "python -m
   * playtest_pipeline.cli" also works when the package is installed but the
   * Scripts dir is not on PATH.
   */
  command: string;
  /** faster-whisper model size passed as --model. */
  model: string;
  /** Mark→segment policy (tech-stack §5.4): seconds kept before/after a mark. */
  preSeconds: number;
  postSeconds: number;
  /** Segments closer than this many seconds merge into one. */
  mergeGapSeconds: number;
}

export interface RecorderConfig {
  obs: ObsConnectionConfig;
  hotkeys: HotkeyConfig;
  telemetry: TelemetryConfig;
  pipeline: PipelineConfig;
  /** Where per-session directories (sidecar, pipeline output) are created. */
  sessionsDir: string;
  /** Path to capture-helper.exe; auto-detected from the repo when empty. */
  helperPath: string;
  /** True once the first-run wizard has been completed (or dismissed). */
  setupDone: boolean;
}

/** One past session found under `sessionsDir` (from its sidecar). */
export interface SessionListEntry {
  id: string;
  title: string;
  sessionDir: string;
  startedAtWall: string;
  endedAtWall?: string;
  /** From the record-started → record-stopped events; wall-clock fallback. */
  durationMs: number | null;
  markCount: number;
  recordingFile?: string;
  /** False when the sidecar names a recording that no longer exists on disk. */
  recordingExists: boolean;
  /** `<sessionDir>/report/report.html` exists — the pipeline has run. */
  hasReport: boolean;
  /** Session still open (no `end` line) — a crash or a session in progress. */
  unfinished: boolean;
}

/** Outcome of `sessions:delete` (session folder → Recycle Bin). */
export interface DeleteSessionResult {
  ok: boolean;
  /** False when the confirm dialog was dismissed — that is not an error. */
  deleted: boolean;
  /** True when the OBS recording named in the sidecar went to the bin too. */
  recordingDeleted?: boolean;
  /** Set on failure, and on a partial success (folder gone, recording kept). */
  error?: string;
}

/** Where OBS is installed, for the first-run wizard. */
export interface ObsInstallInfo {
  installed: boolean;
  /** Install directory from the registry / default location, when found. */
  path?: string;
  running: boolean;
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
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  /** A controller/HID press seen by the helper while gamepad capture is armed. */
  | { type: 'capture-input'; binding: HotkeyBinding }
  /** One line of pipeline stdout/stderr while `playtest-pipeline` runs from the app. */
  | { type: 'pipeline-output'; sessionDir: string; line: string }
  | { type: 'pipeline-started'; sessionDir: string; command: string }
  | { type: 'pipeline-done'; sessionDir: string; code: number | null; reportPath?: string };

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
  /**
   * Arm helper-based controller capture: the next XInput/HID button press
   * arrives as a 'capture-input' push event. Keyboard/mouse capture happens
   * in the renderer via DOM events and does not need this.
   */
  gamepadCaptureStart(): Promise<{ ok: boolean; error?: string }>;
  gamepadCaptureStop(): Promise<void>;
  /** Pause/resume the OBS recording (also in the tray menu). */
  pauseSession(): Promise<{ ok: boolean; error?: string }>;
  resumeSession(): Promise<{ ok: boolean; error?: string }>;
  /** Past sessions under `sessionsDir`, newest first. */
  listSessions(): Promise<SessionListEntry[]>;
  openSessionReport(sessionDir: string): Promise<{ ok: boolean; error?: string }>;
  openSessionFolder(sessionDir: string): Promise<{ ok: boolean; error?: string }>;
  /**
   * Confirm (native modal, main process), then move the session directory to
   * the Recycle Bin — optionally its OBS recording as well.
   */
  deleteSession(sessionDir: string): Promise<DeleteSessionResult>;
  /** Spawn `playtest-pipeline process <sessionDir>`; output streams as push events. */
  runPipeline(sessionDir: string): Promise<{ ok: boolean; error?: string }>;
  cancelPipeline(): Promise<void>;
  /** Read-only playtest-rig advisories (Game DVR, HAGS, power plan — perf §8). */
  rigAdvisories(): Promise<PreflightCheck[]>;
  /** OBS install detection for the first-run wizard. */
  obsDetectInstall(): Promise<ObsInstallInfo>;
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
  gamepadCaptureStart: 'capture:gamepad-start',
  gamepadCaptureStop: 'capture:gamepad-stop',
  pauseSession: 'session:pause',
  resumeSession: 'session:resume',
  listSessions: 'sessions:list',
  openSessionReport: 'sessions:open-report',
  openSessionFolder: 'sessions:open-folder',
  deleteSession: 'sessions:delete',
  runPipeline: 'pipeline:run',
  cancelPipeline: 'pipeline:cancel',
  rigAdvisories: 'rig:advisories',
  obsDetectInstall: 'obs:detect-install',
  pushEvent: 'recorder:event',
} as const;
