/**
 * Session sidecar contract (`session.json` + `session.journal.jsonl`).
 *
 * The sidecar is the SOURCE OF TRUTH for marks. OBS Hybrid MP4 chapters are a
 * redundant convenience copy: they are written at file finalization and are
 * lost if OBS crashes mid-session (tech-stack report §3.2), so nothing
 * downstream may depend on them. The journal is an append-only crash log the
 * pipeline can rebuild `session.json` from.
 *
 * All times are integer-ish milliseconds. Two clock domains exist:
 *  - `monoMs`  — monotonic milliseconds since an arbitrary process epoch
 *                (wall clocks jump; monotonic clocks don't).
 *  - `videoMs` — position in the OBS recording, anchored via
 *                `GetRecordStatus.outputDuration` (immune to StartRecord
 *                latency and PauseRecord skew; tech-stack report §3.4).
 */

export const SIDECAR_SCHEMA_VERSION = 1 as const;

export const SIDECAR_FILENAME = 'session.json';
export const JOURNAL_FILENAME = 'session.journal.jsonl';

/** What is being recorded. No assumption is made about the target (§3.1). */
export type CaptureTargetKind = 'game' | 'video' | 'app' | 'device' | 'other';

export interface CaptureTarget {
  kind: CaptureTargetKind;
  /** Free-form display name, e.g. "DungeonSweeper2" or "scrcpy mirror". */
  name?: string;
}

export type MarkKind = 'manual' | 'vad' | 'auto';

/** How a mark's `videoMs` was derived. */
export type AnchorMethod = 'direct' | 'calibrated' | 'none';

export interface MarkAnchorInfo {
  method: AnchorMethod;
  /** `GetRecordStatus.outputDuration` from the anchoring status call, ms. */
  outputDurationMs?: number;
  /** Round-trip time of that status call, ms. */
  rttMs?: number;
}

export interface Mark {
  id: string;
  /** 1-based press order within the session. */
  seq: number;
  kind: MarkKind;
  /** Semantic label, e.g. "mark", "issue". Feeds chapter names and the report. */
  label: string;
  /** Accelerator that fired, e.g. "F8" (manual marks only). */
  hotkey?: string;
  /** Monotonic stamp taken first thing in the hotkey handler. */
  monoMs: number;
  /** Anchored position in the recording; null if anchoring failed entirely. */
  videoMs: number | null;
  /** In-game time when the target is an instrumented game (§3.5); else null. */
  gameTimeMs?: number | null;
  anchor?: MarkAnchorInfo;
}

export type SessionEventType =
  | 'record-started'
  | 'record-paused'
  | 'record-resumed'
  | 'record-stopped'
  | 'obs-disconnected'
  | 'obs-reconnected'
  | 'telemetry-connected'
  | 'telemetry-lost'
  | 'chapter-create-failed';

export interface SessionEvent {
  type: SessionEventType;
  monoMs: number;
  videoMs?: number | null;
  detail?: string;
}

/** Sparse samples of game telemetry, for timeline reconstruction. */
export interface TelemetrySample {
  monoMs: number;
  gameTimeMs: number;
  paused: boolean;
}

export interface ObsInfo {
  obsVersion?: string;
  obsWebSocketVersion?: string;
  /** Profile parameter AdvOut/RecFormat2 at record time (want "hybrid_mp4"). */
  recFormat?: string;
  /** Audio track bitmask AdvOut/RecTracks at record time (want mic on track 2). */
  recTracks?: string;
}

export interface SessionInfo {
  /** Directory-safe id, e.g. "2026-08-22_1530_dungeon-sweeper". */
  id: string;
  title: string;
  startedAtWall: string; // ISO 8601
  endedAtWall?: string;
  captureTarget: CaptureTarget;
  /** Absolute path OBS reported from StopRecord.outputPath. */
  recordingFile?: string;
  obs?: ObsInfo;
}

export interface SessionSidecar {
  schemaVersion: typeof SIDECAR_SCHEMA_VERSION;
  session: SessionInfo;
  marks: Mark[];
  events: SessionEvent[];
  telemetry: TelemetrySample[];
}

/** One line of `session.journal.jsonl` — append-only crash-safety log. */
export type JournalLine =
  | { t: 'session'; data: SessionInfo }
  | { t: 'mark'; data: Mark }
  | { t: 'event'; data: SessionEvent }
  | { t: 'telemetry'; data: TelemetrySample }
  | { t: 'end'; data: { endedAtWall: string; recordingFile?: string } };

export function emptySidecar(session: SessionInfo): SessionSidecar {
  return {
    schemaVersion: SIDECAR_SCHEMA_VERSION,
    session,
    marks: [],
    events: [],
    telemetry: [],
  };
}

/** Rebuild a sidecar from journal lines (order-preserving; last wins for session info). */
export function sidecarFromJournal(lines: JournalLine[]): SessionSidecar | null {
  let session: SessionInfo | null = null;
  const marks: Mark[] = [];
  const events: SessionEvent[] = [];
  const telemetry: TelemetrySample[] = [];
  for (const line of lines) {
    switch (line.t) {
      case 'session':
        session = line.data;
        break;
      case 'mark':
        marks.push(line.data);
        break;
      case 'event':
        events.push(line.data);
        break;
      case 'telemetry':
        telemetry.push(line.data);
        break;
      case 'end': {
        const current = session;
        if (current) {
          const updated: SessionInfo = { ...current, endedAtWall: line.data.endedAtWall };
          if (line.data.recordingFile) updated.recordingFile = line.data.recordingFile;
          session = updated;
        }
        break;
      }
    }
  }
  if (!session) return null;
  return { schemaVersion: SIDECAR_SCHEMA_VERSION, session, marks, events, telemetry };
}
