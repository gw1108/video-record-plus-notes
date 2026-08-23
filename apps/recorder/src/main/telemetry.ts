/**
 * Optional in-game time poller (tech-stack report §3.5). Only meaningful when
 * the capture target is a game the user instruments with the tiny telemetry
 * SDK (docs/telemetry-protocol.md): the game serves current in-game time over
 * localhost; marks get stamped {videoMs, gameTimeMs}. For every other target
 * this stays disabled and marks carry videoMs alone.
 */
import { EventEmitter } from 'node:events';
import type { TelemetryConfig } from '../common/ipc-contract.js';
import { monoMs } from './util.js';

interface LatestSample {
  monoMs: number;
  gameTimeMs: number;
  paused: boolean;
}

const STALE_AFTER_MS = 2500;

export class TelemetryPoller extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private latest: LatestSample | null = null;
  private wasConnected = false;

  constructor(private readonly cfg: TelemetryConfig) {
    super();
  }

  start(): void {
    if (!this.cfg.enabled || this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.cfg.pollIntervalMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.latest = null;
    this.wasConnected = false;
  }

  get connected(): boolean {
    return this.latest !== null && monoMs() - this.latest.monoMs < STALE_AFTER_MS;
  }

  private async poll(): Promise<void> {
    try {
      const res = await fetch(this.cfg.url, { signal: AbortSignal.timeout(400) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, unknown>;
      const gameTimeMs = Number(body['gameTimeMs'] ?? body['game_time_ms']);
      const paused = Boolean(body['paused'] ?? false);
      if (!Number.isFinite(gameTimeMs)) throw new Error('missing gameTimeMs');
      this.latest = { monoMs: monoMs(), gameTimeMs, paused };
      if (!this.wasConnected) {
        this.wasConnected = true;
        this.emit('connected');
      }
    } catch {
      if (this.wasConnected && !this.connected) {
        this.wasConnected = false;
        this.latest = null;
        this.emit('lost');
      }
    }
  }

  /** Latest sample for sparse sidecar logging, or null. */
  sample(): LatestSample | null {
    return this.connected ? this.latest : null;
  }

  /**
   * In-game time at a press instant. While unpaused, extrapolate from the last
   * sample; while paused, game time holds still (this is exactly the
   * "I pause the game while dictating" case — videoMs advances, gameTimeMs
   * doesn't).
   */
  gameTimeAt(pressMonoMs: number): number | null {
    const s = this.sample();
    if (!s) return null;
    if (s.paused) return Math.round(s.gameTimeMs);
    return Math.round(s.gameTimeMs + (pressMonoMs - s.monoMs));
  }
}
