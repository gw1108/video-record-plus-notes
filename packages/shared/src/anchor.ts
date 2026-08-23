/**
 * Mark → recording-position anchoring math (tech-stack report §3.4).
 *
 * A monotonic stamp alone cannot be mapped to a position in the video file:
 * StartRecord has latency jitter, OBS begins writing frames at an instant the
 * app never observes, and PauseRecord makes monotonic time diverge from output
 * time entirely. The anchor is `GetRecordStatus.outputDuration` — OBS's own
 * notion of the current recording position.
 *
 * Pure functions here so the arithmetic is unit-testable without OBS.
 */

export interface StatusSample {
  /** Monotonic ms just before the GetRecordStatus call was sent. */
  sentMonoMs: number;
  /** Monotonic ms when the response arrived. */
  recvMonoMs: number;
  /** GetRecordStatus.outputDuration (ms). */
  outputDurationMs: number;
}

/**
 * Map a hotkey-press instant to a recording position using a status sample
 * taken immediately after the press.
 *
 * `outputDuration` reflects OBS's position at some instant within
 * [sent, recv]; we assume the midpoint, then walk back the monotonic time
 * elapsed since the press. Clamped to >= 0 (a press microseconds after
 * record-start can otherwise go negative).
 */
export function anchorFromDirectSample(pressMonoMs: number, s: StatusSample): number {
  const statusInstant = s.sentMonoMs + (s.recvMonoMs - s.sentMonoMs) / 2;
  return Math.max(0, Math.round(s.outputDurationMs - (statusInstant - pressMonoMs)));
}

/**
 * Offset of the recording clock relative to the monotonic clock for one
 * sample: `videoMs ≈ monoMs + offset` while recording is running (not paused).
 */
export function offsetOfSample(s: StatusSample): number {
  const statusInstant = s.sentMonoMs + (s.recvMonoMs - s.sentMonoMs) / 2;
  return s.outputDurationMs - statusInstant;
}

/**
 * Rolling calibration over recent samples. Median resists individual slow
 * status calls (an individual call being slow must not skew marks — §3.4).
 * Calibration is only valid within one non-paused stretch: callers must
 * `reset()` on pause/resume and on record start.
 */
export class OffsetCalibration {
  private offsets: number[] = [];
  constructor(private readonly capacity = 11) {}

  addSample(s: StatusSample): void {
    this.offsets.push(offsetOfSample(s));
    if (this.offsets.length > this.capacity) this.offsets.shift();
  }

  reset(): void {
    this.offsets = [];
  }

  get sampleCount(): number {
    return this.offsets.length;
  }

  /** Median offset, or null with no samples. */
  offsetMs(): number | null {
    if (this.offsets.length === 0) return null;
    const sorted = [...this.offsets].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    return median;
  }

  /** Map a press instant through the calibrated offset (fallback path). */
  anchorMonoMs(pressMonoMs: number): number | null {
    const offset = this.offsetMs();
    if (offset === null) return null;
    return Math.max(0, Math.round(pressMonoMs + offset));
  }
}
