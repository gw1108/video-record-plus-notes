/**
 * OBS first-run preflight (tech-stack report risk 8): validate the separately
 * installed OBS is new enough and configured for Hybrid MP4 + mic on audio
 * track 2, and offer to apply what obs-websocket can set. Encoder tuning
 * (NVENC single-pass CQP, psycho-visual tuning off, lookahead off — perf
 * report §2.3) is not reachable over obs-websocket, so those surface as
 * warnings with instructions instead of silent writes.
 */
import type { PreflightCheck } from '../common/ipc-contract.js';
import type { ObsClient } from './obs.js';

const MIN_OBS_MAJOR = 30;
const MIN_OBS_MINOR = 2;
const MIN_WS = [5, 4] as const;

function parseVersion(v: string): number[] {
  return v.split('.').map((p) => Number.parseInt(p, 10) || 0);
}

function versionAtLeast(v: string, major: number, minor: number): boolean {
  const [a = 0, b = 0] = parseVersion(v);
  return a > major || (a === major && b >= minor);
}

/** RecTracks is a bitmask string; mic rides track 2 (bit 1<<1). */
function tracksIncludeMic(recTracks: string | null): boolean {
  const mask = Number.parseInt(recTracks ?? '1', 10);
  return Number.isFinite(mask) && (mask & 0b10) !== 0;
}

const HARDWARE_ENCODER_HINTS = ['nvenc', 'amf', 'qsv', 'av1'];

export async function runPreflight(obs: ObsClient): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const push = (c: PreflightCheck) => checks.push(c);

  if (!obs.connected) {
    push({
      id: 'connection',
      label: 'obs-websocket connection',
      status: 'fail',
      detail: 'Not connected to OBS. Enable WebSocket Server in OBS (Tools → WebSocket Server Settings) and connect.',
      fixable: false,
    });
    return checks;
  }

  const version = await obs.getVersion();
  push({
    id: 'obs-version',
    label: `OBS ${version.obsVersion}`,
    status: versionAtLeast(version.obsVersion, MIN_OBS_MAJOR, MIN_OBS_MINOR) ? 'pass' : 'fail',
    detail: `Hybrid MP4 + CreateRecordChapter need OBS ${MIN_OBS_MAJOR}.${MIN_OBS_MINOR}+.`,
    fixable: false,
  });
  push({
    id: 'ws-version',
    label: `obs-websocket ${version.obsWebSocketVersion}`,
    status: versionAtLeast(version.obsWebSocketVersion, MIN_WS[0], MIN_WS[1]) ? 'pass' : 'fail',
    detail: `CreateRecordChapter needs obs-websocket ${MIN_WS[0]}.${MIN_WS[1]}+.`,
    fixable: false,
  });

  const mode = await obs.getProfileParameter('Output', 'Mode');
  const advanced = mode === 'Advanced';
  push({
    id: 'output-mode',
    label: 'Advanced output mode',
    status: advanced ? 'pass' : 'warn',
    detail: advanced
      ? 'Advanced output mode active.'
      : 'Simple output mode cannot put the mic on its own audio track. Recommended: Advanced.',
    fixable: true,
  });

  const recFormat = await obs.getProfileParameter('AdvOut', 'RecFormat2');
  const hybrid = recFormat === 'hybrid_mp4';
  push({
    id: 'rec-format',
    label: `Recording format: ${recFormat ?? 'unknown'}`,
    status: hybrid ? 'pass' : 'fail',
    detail: hybrid
      ? 'Hybrid MP4 supports chapter marks and crash recovery.'
      : 'Hybrid MP4 is required for CreateRecordChapter and crash recovery. (Settings → Output → Recording → Format).',
    fixable: true,
  });

  const recTracks = await obs.getProfileParameter('AdvOut', 'RecTracks');
  const micTrack = tracksIncludeMic(recTracks);
  push({
    id: 'rec-tracks',
    label: `Audio tracks bitmask: ${recTracks ?? 'unknown'}`,
    status: micTrack ? 'pass' : 'warn',
    detail: micTrack
      ? 'Track 2 is recorded — route the mic to track 2 only (Advanced Audio Properties) so the pipeline can extract clean mic audio for STT.'
      : 'Enable audio track 2 and route the mic to it (game/system audio on track 1). The pipeline extracts track 2 for speech-to-text.',
    fixable: true,
  });

  // RecEncoder "none" is OBS for "(Use stream encoder)" — the actual encoder
  // is then AdvOut/Encoder. Verified live on OBS 32.2 (M1): with a shared
  // stream encoder, PauseRecord silently no-ops and ResumeRecord fails (503),
  // so pause/resume needs a dedicated recording encoder. Encoder changes made
  // over obs-websocket only take effect after an OBS restart.
  let encoder = (await obs.getProfileParameter('AdvOut', 'RecEncoder')) ?? '';
  const sharedWithStream = !encoder || encoder === 'none';
  let encoderLabel = encoder;
  if (sharedWithStream) {
    encoder = (await obs.getProfileParameter('AdvOut', 'Encoder')) ?? '';
    encoderLabel = `${encoder || 'unknown'} (via stream encoder)`;
  }
  const hardware = HARDWARE_ENCODER_HINTS.some((h) => encoder.toLowerCase().includes(h));
  push({
    id: 'encoder',
    label: `Recording encoder: ${encoderLabel || 'unknown'}`,
    status: hardware && !sharedWithStream ? 'pass' : 'warn',
    detail: !hardware
      ? 'Software x264 while a game runs risks frame skipping (perf report §2.1). Select NVENC/AMF/QSV in Settings → Output → Recording.'
      : sharedWithStream
        ? 'Hardware encoder, but shared with streaming: OBS cannot pause the recording in this mode. Set a dedicated encoder under Settings → Output → Recording and restart OBS.'
        : 'Hardware encoder detected. Also verify in OBS: single-pass, CQP 18–20, psycho-visual tuning OFF, lookahead OFF, NV12, canvas = output resolution, preview disabled (perf report §2.3).',
    fixable: false,
  });

  try {
    const dir = await obs.getRecordDirectory();
    push({
      id: 'record-dir',
      label: `Recording directory: ${dir}`,
      status: 'pass',
      detail: 'Prefer an internal SSD that is not the game drive (perf report §7).',
      fixable: false,
    });
  } catch {
    push({
      id: 'record-dir',
      label: 'Recording directory',
      status: 'warn',
      detail: 'Could not read the recording directory.',
      fixable: false,
    });
  }

  return checks;
}

/**
 * Apply the settings obs-websocket can write. Profile parameters are read by
 * OBS when the next recording starts; restarting OBS afterwards is the safe
 * path and the UI says so.
 */
export async function applyRecommended(obs: ObsClient): Promise<PreflightCheck[]> {
  await obs.setProfileParameter('Output', 'Mode', 'Advanced');
  await obs.setProfileParameter('AdvOut', 'RecFormat2', 'hybrid_mp4');
  const recTracks = await obs.getProfileParameter('AdvOut', 'RecTracks');
  const mask = Number.parseInt(recTracks ?? '1', 10) || 1;
  await obs.setProfileParameter('AdvOut', 'RecTracks', String(mask | 0b11));
  return runPreflight(obs);
}
