/**
 * Thin wrapper around obs-websocket-js. Capture stays in OBS (a separate
 * installed program driven over its documented JSON WebSocket API) — the IPC
 * boundary is what keeps this app free of OBS's GPL (tech-stack report §3.2).
 */
import { EventEmitter } from 'node:events';
import OBSWebSocket from 'obs-websocket-js';
import type { ObsConnectionConfig } from '../common/ipc-contract.js';
import { monoMs } from './util.js';
import type { StatusSample } from '@playtest/shared';

export interface RecordStateEvent {
  outputActive: boolean;
  outputState: string;
  outputPath: string | null;
}

export interface RecordStatusSample {
  sample: StatusSample;
  active: boolean;
  paused: boolean;
}

export class ObsClient extends EventEmitter {
  private obs = new OBSWebSocket();
  private _connected = false;
  private intentionalDisconnect = false;

  constructor() {
    super();
    this.obs.on('ConnectionClosed', () => {
      const was = this._connected;
      this._connected = false;
      if (was && !this.intentionalDisconnect) this.emit('disconnected');
    });
    this.obs.on('RecordStateChanged', (data) => {
      this.emit('record-state', data as unknown as RecordStateEvent);
    });
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(cfg: ObsConnectionConfig): Promise<{ obsWebSocketVersion: string }> {
    this.intentionalDisconnect = false;
    const url = `ws://${cfg.host}:${cfg.port}`;
    const result = await this.obs.connect(url, cfg.password || undefined);
    this._connected = true;
    this.emit('connected');
    return { obsWebSocketVersion: result.obsWebSocketVersion };
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    await this.obs.disconnect();
    this._connected = false;
  }

  async getVersion(): Promise<{ obsVersion: string; obsWebSocketVersion: string }> {
    const v = await this.obs.call('GetVersion');
    return { obsVersion: v.obsVersion, obsWebSocketVersion: v.obsWebSocketVersion };
  }

  async getRecordDirectory(): Promise<string> {
    const r = await this.obs.call('GetRecordDirectory');
    return r.recordDirectory;
  }

  async getProfileParameter(category: string, name: string): Promise<string | null> {
    const r = await this.obs.call('GetProfileParameter', {
      parameterCategory: category,
      parameterName: name,
    });
    return (r.parameterValue as string | null) ?? null;
  }

  async setProfileParameter(category: string, name: string, value: string): Promise<void> {
    await this.obs.call('SetProfileParameter', {
      parameterCategory: category,
      parameterName: name,
      parameterValue: value,
    });
  }

  async startRecord(): Promise<void> {
    await this.obs.call('StartRecord');
  }

  async stopRecord(): Promise<string | undefined> {
    const r = await this.obs.call('StopRecord');
    return r.outputPath as string | undefined;
  }

  /**
   * Timestamped GetRecordStatus — the anchor for all mark→videoMs mapping
   * (§3.4). Returns the raw sample plus OBS's active/paused flags.
   */
  async sampleRecordStatus(): Promise<RecordStatusSample> {
    const sentMonoMs = monoMs();
    const r = await this.obs.call('GetRecordStatus');
    const recvMonoMs = monoMs();
    return {
      sample: { sentMonoMs, recvMonoMs, outputDurationMs: r.outputDuration as number },
      active: r.outputActive as boolean,
      paused: r.outputPaused as boolean,
    };
  }

  /**
   * Insert a named chapter into the Hybrid MP4 recording. Redundant
   * convenience copy of the sidecar mark — chapters are written at file
   * finalization and lost on OBS crash, so failures are non-fatal.
   */
  async createRecordChapter(chapterName: string): Promise<void> {
    await this.obs.call('CreateRecordChapter', { chapterName });
  }
}
