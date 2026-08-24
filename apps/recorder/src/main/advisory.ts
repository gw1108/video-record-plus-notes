/**
 * Playtest-rig advisories (perf report §8): read-only checks of the Windows
 * settings that most often cost frames or encoder latency during a session.
 * Advisory only — this app never changes system settings; every row says
 * where to flip it by hand. Reuses the PreflightCheck shape so the UI can
 * render it next to the OBS preflight.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PreflightCheck } from '../common/ipc-contract.js';

const execFileAsync = promisify(execFile);

/** Read one REG_DWORD; null when the value/key is absent or reg fails. */
async function regDword(key: string, name: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('reg', ['query', key, '/v', name], { windowsHide: true });
    const match = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout);
    return match ? Number.parseInt(match[1]!, 16) : null;
  } catch {
    return null;
  }
}

const HIGH_PERF_SCHEMES: Record<string, string> = {
  '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c': 'High performance',
  'e9a42b02-d5df-448d-aa00-03f14749eb61': 'Ultimate Performance',
};

async function activePowerScheme(): Promise<{ guid: string; name: string } | null> {
  try {
    const { stdout } = await execFileAsync('powercfg', ['/getactivescheme'], { windowsHide: true });
    const match = /GUID:\s*([0-9a-f-]{36})\s*(?:\((.*?)\))?/i.exec(stdout);
    if (!match) return null;
    return { guid: match[1]!.toLowerCase(), name: match[2]?.trim() || match[1]! };
  } catch {
    return null;
  }
}

export async function rigAdvisories(): Promise<PreflightCheck[]> {
  if (process.platform !== 'win32') return [];
  const checks: PreflightCheck[] = [];

  // Game DVR background recording + Game Bar capture (OBS KB: conflicts with
  // hardware-encoding apps). Both default ON on a fresh Windows install.
  const dvr = await regDword('HKCU\\System\\GameConfigStore', 'GameDVR_Enabled');
  const appCapture = await regDword(
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR',
    'AppCaptureEnabled',
  );
  const dvrOff = dvr === 0 && appCapture === 0;
  checks.push({
    id: 'game-dvr',
    label: `Xbox Game Bar capture / Game DVR: ${dvrOff ? 'off' : 'on'}`,
    status: dvrOff ? 'pass' : 'warn',
    detail: dvrOff
      ? 'Background recording is off — no second capture pipeline competing with OBS.'
      : 'Turn off Settings → Gaming → Captures → "Record in the background" and Xbox Game Bar (Settings → Gaming → Xbox Game Bar). Game DVR conflicts with hardware-encoding apps (perf §8).',
    fixable: false,
  });

  // Hardware-accelerated GPU scheduling: 2 = on, 1 = off, absent = driver default.
  const hags = await regDword('HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', 'HwSchMode');
  const hagsOn = hags === 2;
  checks.push({
    id: 'hags',
    label: `Hardware-accelerated GPU scheduling: ${hags === null ? 'not set (driver default)' : hagsOn ? 'on' : 'off'}`,
    status: hagsOn ? 'warn' : 'pass',
    detail: hagsOn
      ? 'OBS reports encoder latency spikes with HAGS on some drivers. Advisory: Settings → System → Display → Graphics → Change default graphics settings → off, then reboot. Leave it on if a game needs it (DLSS 3 frame generation).'
      : 'Off/default is the recommended state for a playtest rig (perf §8); effects are driver-dependent, test per machine.',
    fixable: false,
  });

  const scheme = await activePowerScheme();
  const highPerf = scheme ? scheme.guid in HIGH_PERF_SCHEMES : false;
  checks.push({
    id: 'power-plan',
    label: `Power plan: ${scheme?.name ?? 'unknown'}`,
    status: highPerf ? 'pass' : 'warn',
    detail: highPerf
      ? 'Cores stay unparked; wake latency will not eat frame budget.'
      : 'Balanced/Power saver park cores aggressively (1–15 ms wakes). Advisory: Control Panel → Power Options → High performance while playtesting (perf §8).',
    fixable: false,
  });

  return checks;
}
