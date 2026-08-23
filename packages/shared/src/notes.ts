/**
 * Post-session pipeline output contracts: notes, transcript, cut map, and the
 * report data blob embedded into the player page and consumed by the Notion
 * publisher. The Python pipeline emits JSON with exactly these camelCase keys
 * (`report_data.json`, `cutmap.json`, `notes.json`).
 */

export const REPORT_SCHEMA_VERSION = 1 as const;

export interface TranscriptWord {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  words?: TranscriptWord[];
}

/** A note = a mark enriched with its transcribed speech and segment window. */
export interface Note {
  id: string;
  kind: 'manual' | 'vad' | 'auto';
  label: string;
  /** Anchored instant in ORIGINAL recording time. */
  videoMs: number;
  gameTimeMs?: number | null;
  /** Transcribed speech attached to this note ('' when STT was skipped). */
  text: string;
  /** Segment window in ORIGINAL recording time (mark→segment policy §5.4). */
  windowStartMs: number;
  windowEndMs: number;
}

/**
 * One condensed-cut segment, built from ACTUAL post-keyframe-snap boundaries
 * (ffprobe of the emitted segment — never the requested times, §5.4).
 */
export interface CutSegment {
  originalStartMs: number;
  originalEndMs: number;
  condensedStartMs: number;
  condensedEndMs: number;
}

/** A marked range in original time (drives the segment-skip player module). */
export interface MarkedRange {
  startMs: number;
  endMs: number;
  noteIds: string[];
}

export interface ReportVideo {
  /** Path relative to the report directory, e.g. "condensed.mp4". */
  file: string;
  /** Whether `file` is the full original recording or the condensed cut. */
  kind: 'original' | 'condensed';
  durationMs: number;
}

export interface ReportData {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  session: {
    id: string;
    title: string;
    date: string; // ISO 8601 of session start
    originalDurationMs: number;
  };
  video: ReportVideo;
  notes: Note[];
  /** Marked ranges in ORIGINAL time (for skip playback + timeline markers). */
  ranges: MarkedRange[];
  /** Present (non-empty) when video.kind === 'condensed'. */
  cutmap: CutSegment[];
  transcript: TranscriptSegment[];
}

/** Translate an original-time instant into condensed time via the cut map. */
export function originalToCondensedMs(cutmap: CutSegment[], originalMs: number): number | null {
  for (const seg of cutmap) {
    if (originalMs >= seg.originalStartMs && originalMs <= seg.originalEndMs) {
      return seg.condensedStartMs + (originalMs - seg.originalStartMs);
    }
  }
  // In a gap: snap to the start of the next kept segment, if any.
  for (const seg of cutmap) {
    if (seg.originalStartMs > originalMs) return seg.condensedStartMs;
  }
  return null;
}

/** Translate a condensed-time instant back into original time via the cut map. */
export function condensedToOriginalMs(cutmap: CutSegment[], condensedMs: number): number | null {
  for (const seg of cutmap) {
    if (condensedMs >= seg.condensedStartMs && condensedMs <= seg.condensedEndMs) {
      return seg.originalStartMs + (condensedMs - seg.condensedStartMs);
    }
  }
  return null;
}
