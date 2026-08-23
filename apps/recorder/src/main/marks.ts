/**
 * Mark anchoring service (§3.4). On each mark:
 *  1. the press instant is stamped on the monotonic clock (by the caller,
 *     first thing in the hotkey handler);
 *  2. a GetRecordStatus round-trip anchors it to OBS's outputDuration;
 *  3. if that call fails (e.g. OBS briefly unreachable), fall back to the
 *     rolling median calibration maintained by a background timer.
 */
import { anchorFromDirectSample, OffsetCalibration, type MarkAnchorInfo } from '@playtest/shared';
import type { ObsClient } from './obs.js';

const CALIBRATION_INTERVAL_MS = 5000;

export interface AnchorResult {
  videoMs: number | null;
  anchor: MarkAnchorInfo;
}

export class MarkAnchorService {
  private calibration = new OffsetCalibration();
  private timer: NodeJS.Timeout | null = null;
  private paused = false;

  constructor(private readonly obs: ObsClient) {}

  start(): void {
    this.calibration.reset();
    this.paused = false;
    this.timer = setInterval(() => void this.calibrate(), CALIBRATION_INTERVAL_MS);
    void this.calibrate();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.calibration.reset();
  }

  /** Pause/resume make monotonic and output time diverge; drop calibration. */
  onPauseBoundary(paused: boolean): void {
    this.paused = paused;
    this.calibration.reset();
  }

  private async calibrate(): Promise<void> {
    if (!this.obs.connected || this.paused) return;
    try {
      const status = await this.obs.sampleRecordStatus();
      if (status.active && !status.paused) this.calibration.addSample(status.sample);
    } catch {
      // transient; next tick will retry
    }
  }

  async anchorPress(pressMonoMs: number): Promise<AnchorResult> {
    try {
      const status = await this.obs.sampleRecordStatus();
      // An inactive output (OBS restarted mid-session) reports a meaningless
      // outputDuration ≈ 0: anchoring against it would stamp wrong data as
      // 'direct' AND poison the calibration that is correctly extrapolating
      // the pre-crash timeline. Treat it like an unreachable OBS.
      if (status.active) {
        const { sample } = status;
        if (!status.paused) this.calibration.addSample(sample);
        return {
          videoMs: anchorFromDirectSample(pressMonoMs, sample),
          anchor: {
            method: 'direct',
            outputDurationMs: sample.outputDurationMs,
            rttMs: sample.recvMonoMs - sample.sentMonoMs,
          },
        };
      }
    } catch {
      // fall through to the calibrated anchor
    }
    const videoMs = this.calibration.anchorMonoMs(pressMonoMs);
    return videoMs !== null
      ? { videoMs, anchor: { method: 'calibrated' } }
      : { videoMs: null, anchor: { method: 'none' } };
  }
}
